const CHUNK_SIZE = 16 * 1024; // 16 KB
const HIGH_WATER = 16 * 1024 * 1024; // pause sending above 16 MB buffered
const LOW_WATER = 1 * 1024 * 1024; // resume below 1 MB
const IN_MEMORY_CAP = 1024 * 1024 * 1024; // 1 GB hard cap for the fallback path
const READY_TIMEOUT_MS = 30 * 1000; // sender waits this long for the receiver's ready ack
const DRAIN_TIMEOUT_MS = 30 * 1000; // fail if the send buffer never drains (dead/stuck peer)

export const FSAA_WARN_FLOOR = 256 * 1024 * 1024; // 256 MB
export const LARGE_FILE_WARN = 2 * 1024 * 1024 * 1024; // 2 GB
export const MAX_TRANSFER_FILES = 32;

const FLAG_LAST = 0x01;

export function isFsaaAvailable(): boolean {
  return typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function';
}

interface ManifestFile {
  index: number;
  name: string;
  size: number;
  mime: string;
}
interface Manifest {
  transfer_id: string;
  files: ManifestFile[];
}

export interface ProgressInfo {
  fraction: number;
  transferred: number;
  total: number;
}

export interface PeerCallbacks {
  sendOffer: (sdp: RTCSessionDescriptionInit) => void;
  sendAnswer: (sdp: RTCSessionDescriptionInit) => void;
  sendIce: (candidate: RTCIceCandidateInit) => void;
  onProgress: (p: ProgressInfo) => void;
  onComplete: () => void;
  onFailure: (reason: string, message: string) => void;
}

const FAILURE_MESSAGE =
  'Connection failed — your network may not allow P2P. Try the bucket upload instead.';

/** Shared ICE-state monitoring; promotes the listed states to a terminal failure. No restart-ICE. */
function attachIceMonitoring(
  pc: RTCPeerConnection,
  fail: (reason: string, message: string) => void,
): () => void {
  let disconnectedTimer: ReturnType<typeof setTimeout> | null = null;
  let checkingTimer: ReturnType<typeof setTimeout> | null = null;

  const clearTimers = () => {
    if (disconnectedTimer) clearTimeout(disconnectedTimer);
    if (checkingTimer) clearTimeout(checkingTimer);
    disconnectedTimer = null;
    checkingTimer = null;
  };

  const onChange = () => {
    switch (pc.iceConnectionState) {
      case 'failed':
        clearTimers();
        fail('ice_failed', FAILURE_MESSAGE);
        break;
      case 'disconnected':
        if (!disconnectedTimer) {
          disconnectedTimer = setTimeout(() => {
            if (pc.iceConnectionState === 'disconnected') fail('ice_failed', FAILURE_MESSAGE);
          }, 10_000);
        }
        break;
      case 'checking':
        if (!checkingTimer) {
          checkingTimer = setTimeout(() => {
            if (pc.iceConnectionState === 'checking') fail('ice_failed', FAILURE_MESSAGE);
          }, 30_000);
        }
        break;
      case 'connected':
      case 'completed':
        clearTimers();
        break;
    }
  };

  pc.addEventListener('iceconnectionstatechange', onChange);
  return clearTimers;
}

function waitForDrain(dc: RTCDataChannel): Promise<void> {
  if (dc.bufferedAmount < HIGH_WATER) return Promise.resolve();
  return new Promise((resolve, reject) => {
    dc.bufferedAmountLowThreshold = LOW_WATER;
    const timer = setTimeout(() => {
      dc.removeEventListener('bufferedamountlow', onLow);
      reject(new Error('drain_timeout'));
    }, DRAIN_TIMEOUT_MS);
    const onLow = () => {
      clearTimeout(timer);
      dc.removeEventListener('bufferedamountlow', onLow);
      resolve();
    };
    dc.addEventListener('bufferedamountlow', onLow);
  });
}

// ---- Sender ---------------------------------------------------------------

export class SenderConnection {
  private pc: RTCPeerConnection;
  private dc: RTCDataChannel;
  private cb: PeerCallbacks;
  private files: File[];
  private transferId: string;
  private total: number;
  private sent = 0;
  private cancelled = false;
  private completed = false;
  private clearIce: () => void;
  private ready = false;
  private readyResolve: (() => void) | null = null;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(transferId: string, files: File[], iceServers: RTCIceServer[], cb: PeerCallbacks) {
    this.transferId = transferId;
    this.files = files;
    this.cb = cb;
    this.total = files.reduce((n, f) => n + f.size, 0);
    this.pc = new RTCPeerConnection({ iceServers });
    this.dc = this.pc.createDataChannel('files', { ordered: true });
    this.dc.binaryType = 'arraybuffer';

    this.clearIce = attachIceMonitoring(this.pc, (r, m) => this.fail(r, m));
    this.pc.onicecandidate = (e) => {
      if (e.candidate) cb.sendIce(e.candidate.toJSON());
    };
    this.dc.onopen = () => void this.pump();
    this.dc.onmessage = (ev) => this.onControl(ev.data);
    this.dc.onerror = () => this.fail('datachannel_error', 'Transfer interrupted');
  }

  /** Receiver -> sender control channel. Currently only the `ready` ack. */
  private onControl(data: unknown): void {
    if (typeof data !== 'string') return;
    let msg: { type?: string };
    try {
      msg = JSON.parse(data) as { type?: string };
    } catch {
      return;
    }
    if (msg.type === 'ready') this.markReady();
  }

  private markReady(): void {
    if (this.readyTimer) {
      clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
    this.ready = true;
    this.readyResolve?.();
    this.readyResolve = null;
  }

  /** Resolve once the receiver has set up its sinks; reject on timeout. */
  private waitForReady(): Promise<void> {
    if (this.ready) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyTimer = setTimeout(() => {
        this.readyResolve = null;
        this.readyTimer = null;
        reject(new Error('receiver_timeout'));
      }, READY_TIMEOUT_MS);
    });
  }

  async start(): Promise<void> {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.cb.sendOffer(offer);
  }

  async acceptAnswer(sdp: RTCSessionDescriptionInit): Promise<void> {
    await this.pc.setRemoteDescription(sdp);
  }

  async addIce(candidate: RTCIceCandidateInit): Promise<void> {
    try {
      await this.pc.addIceCandidate(candidate);
    } catch {
      // ignore late/duplicate candidates
    }
  }

  private async pump(): Promise<void> {
    const manifest: Manifest = {
      transfer_id: this.transferId,
      files: this.files.map((f, index) => ({
        index,
        name: f.name,
        size: f.size,
        mime: f.type || 'application/octet-stream',
      })),
    };
    this.dc.send(JSON.stringify(manifest));

    // Wait for the receiver to confirm its sinks are ready before streaming
    // bytes. Without this the receiver can drop early chunks while it is still
    // awaiting save-file pickers / allocating buffers.
    try {
      await this.waitForReady();
    } catch {
      this.fail('receiver_timeout', 'The other person did not start receiving in time.');
      return;
    }
    if (this.cancelled) return;

    for (let index = 0; index < this.files.length; index++) {
      const file = this.files[index];
      let offset = 0;
      while (offset < file.size) {
        if (this.cancelled) return;
        const end = Math.min(offset + CHUNK_SIZE, file.size);
        const buf = await file.slice(offset, end).arrayBuffer();
        const isLast = end >= file.size;
        const frame = new Uint8Array(2 + buf.byteLength);
        frame[0] = index;
        frame[1] = isLast ? FLAG_LAST : 0;
        frame.set(new Uint8Array(buf), 2);
        this.dc.send(frame);
        offset = end;
        this.sent += buf.byteLength;
        this.cb.onProgress({
          fraction: this.total ? this.sent / this.total : 1,
          transferred: this.sent,
          total: this.total,
        });
        try {
          await waitForDrain(this.dc);
        } catch {
          this.fail('stalled', 'Transfer stalled — the connection appears to be stuck.');
          return;
        }
      }
    }
    if (this.cancelled) return;
    this.dc.send(JSON.stringify({ type: 'done' }));
    this.completed = true;
    this.cb.onComplete();
    // The transfer is done. Stop ICE monitoring so the receiver tearing down its
    // connection can't surface a spurious failure, then close once the channel
    // has flushed the final bytes.
    this.clearIce();
    this.closeWhenDrained();
  }

  private closeWhenDrained(): void {
    if (this.dc.bufferedAmount === 0) {
      this.close();
    } else {
      setTimeout(() => this.closeWhenDrained(), 100);
    }
  }

  private fail(reason: string, message: string): void {
    if (this.cancelled || this.completed) return;
    this.cancelled = true;
    this.cb.onFailure(reason, message);
    this.close();
  }

  cancel(): void {
    this.cancelled = true;
    this.close();
  }

  close(): void {
    this.clearIce();
    if (this.readyTimer) {
      clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
    this.readyResolve = null;
    try {
      this.dc.close();
    } catch {
      /* noop */
    }
    try {
      this.pc.close();
    } catch {
      /* noop */
    }
  }
}

// ---- Receiver -------------------------------------------------------------

interface FileSink {
  meta: ManifestFile;
  received: number;
  writable?: FileSystemWritableFileStream;
  chunks?: Uint8Array[];
  done: boolean;
}

export class ReceiverConnection {
  private pc: RTCPeerConnection;
  private cb: PeerCallbacks;
  private useFsaa: boolean;
  private sinks: FileSink[] = [];
  private total = 0;
  private received = 0;
  private cancelled = false;
  private completed = false;
  private clearIce: () => void;
  private manifest: Manifest | null = null;
  private dc: RTCDataChannel | null = null;
  // Serialize message handling: frames arrive on a concurrent async handler, so
  // without a queue the manifest setup (which awaits save pickers) can race
  // chunk handling, dropping early chunks or interleaving writes.
  private queue: Promise<void> = Promise.resolve();

  constructor(iceServers: RTCIceServer[], cb: PeerCallbacks) {
    this.cb = cb;
    this.useFsaa = isFsaaAvailable();
    this.pc = new RTCPeerConnection({ iceServers });
    this.clearIce = attachIceMonitoring(this.pc, (r, m) => this.fail(r, m));
    this.pc.onicecandidate = (e) => {
      if (e.candidate) cb.sendIce(e.candidate.toJSON());
    };
    this.pc.ondatachannel = (e) => {
      const dc = e.channel;
      this.dc = dc;
      dc.binaryType = 'arraybuffer';
      dc.onmessage = (ev) => this.enqueue(ev.data);
      dc.onerror = () => this.fail('datachannel_error', 'Transfer interrupted');
      dc.onclose = () => {
        if (!this.allDone()) this.fail('connection_interrupted', 'Transfer interrupted');
      };
    };
  }

  /** Append to the serial processing chain so messages are handled in order. */
  private enqueue(data: string | ArrayBuffer): void {
    this.queue = this.queue.then(() => this.onMessage(data)).catch(() => {
      this.fail('protocol_error', 'Transfer failed: malformed data.');
    });
  }

  async acceptOffer(sdp: RTCSessionDescriptionInit): Promise<void> {
    await this.pc.setRemoteDescription(sdp);
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    this.cb.sendAnswer(answer);
  }

  async addIce(candidate: RTCIceCandidateInit): Promise<void> {
    try {
      await this.pc.addIceCandidate(candidate);
    } catch {
      // ignore
    }
  }

  private async onMessage(data: string | ArrayBuffer): Promise<void> {
    if (this.cancelled) return;
    if (typeof data === 'string') {
      let msg: { type?: string } & Partial<Manifest>;
      try {
        msg = JSON.parse(data) as { type?: string } & Partial<Manifest>;
      } catch {
        this.fail('protocol_error', 'Transfer failed: malformed control message.');
        return;
      }
      if (msg.type === 'done') {
        await this.finish();
        return;
      }
      await this.setupManifest(msg as Manifest);
      return;
    }
    await this.onChunk(new Uint8Array(data));
  }

  private async setupManifest(manifest: Manifest): Promise<void> {
    this.manifest = manifest;
    this.total = manifest.files.reduce((n, f) => n + f.size, 0);

    if (!this.useFsaa && this.total > IN_MEMORY_CAP) {
      this.fail('too_large', 'File exceeds the 1 GB in-memory limit for this browser.');
      return;
    }

    for (const meta of manifest.files) {
      const sink: FileSink = { meta, received: 0, done: false };
      if (this.useFsaa) {
        try {
          const handle = await window.showSaveFilePicker({ suggestedName: meta.name });
          sink.writable = await handle.createWritable();
        } catch {
          this.fail('save_cancelled', 'Save was cancelled.');
          return;
        }
      } else {
        sink.chunks = [];
      }
      this.sinks[meta.index] = sink;
    }

    // Sinks are ready; tell the sender it can start streaming bytes.
    try {
      this.dc?.send(JSON.stringify({ type: 'ready' }));
    } catch {
      this.fail('connection_interrupted', 'Transfer interrupted');
    }
  }

  private async onChunk(frame: Uint8Array): Promise<void> {
    const index = frame[0];
    const flags = frame[1];
    const payload = frame.subarray(2);
    const sink = this.sinks[index];
    if (!sink) return;

    sink.received += payload.byteLength;
    this.received += payload.byteLength;
    if (sink.received > sink.meta.size) {
      this.fail('size_mismatch', 'Received more data than expected.');
      return;
    }

    if (sink.writable) {
      await sink.writable.write(new Uint8Array(payload));
    } else if (sink.chunks) {
      sink.chunks.push(payload.slice());
    }

    this.cb.onProgress({
      fraction: this.total ? this.received / this.total : 1,
      transferred: this.received,
      total: this.total,
    });

    if (flags & FLAG_LAST) {
      if (sink.received !== sink.meta.size) {
        this.fail('size_mismatch', 'File size did not match.');
        return;
      }
      await this.closeSink(sink);
      sink.done = true;
    }
  }

  private async closeSink(sink: FileSink): Promise<void> {
    if (sink.writable) {
      await sink.writable.close();
    } else if (sink.chunks) {
      const blob = new Blob(sink.chunks as BlobPart[], { type: sink.meta.mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = sink.meta.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      sink.chunks = [];
    }
  }

  private allDone(): boolean {
    return (
      this.manifest !== null &&
      this.sinks.length === this.manifest.files.length &&
      this.sinks.every((s) => s?.done)
    );
  }

  private async finish(): Promise<void> {
    if (!this.allDone()) {
      this.fail('incomplete', 'Transfer ended before all files arrived.');
      return;
    }
    this.completed = true;
    this.clearIce();
    this.cb.onComplete();
    this.close();
  }

  private fail(reason: string, message: string): void {
    if (this.cancelled || this.completed) return;
    this.cancelled = true;
    this.cb.onFailure(reason, message);
    this.close();
  }

  cancel(): void {
    this.cancelled = true;
    this.close();
  }

  close(): void {
    this.clearIce();
    try {
      this.pc.close();
    } catch {
      /* noop */
    }
  }
}
