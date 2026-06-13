import { downloadZip } from "client-zip";

const CHUNK_SIZE = 16 * 1024; // 16 KB
const HIGH_WATER = 16 * 1024 * 1024; // pause sending above 16 MB buffered
const LOW_WATER = 1 * 1024 * 1024; // resume below 1 MB
const IN_MEMORY_CAP = 1024 * 1024 * 1024; // 1 GB hard cap for the fallback path
const READY_TIMEOUT_MS = 30 * 1000; // sender waits this long for the receiver's ready ack
const DRAIN_TIMEOUT_MS = 30 * 1000; // fail if the send buffer never drains (dead/stuck peer)
const COMPLETE_TIMEOUT_MS = 30 * 1000; // sender waits this long for the receiver's "got everything" ack
const RECEIVER_LINGER_MS = 10 * 1000; // receiver keeps the channel open this long so its ack can flush

export const FSAA_WARN_FLOOR = 256 * 1024 * 1024; // 256 MB
export const LARGE_FILE_WARN = 2 * 1024 * 1024 * 1024; // 2 GB
export const MAX_TRANSFER_FILES = 32;

const FLAG_LAST = 0x01;

export function isFsaaAvailable(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.showSaveFilePicker === "function"
  );
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
  "Connection failed — your network may not allow P2P. Try the bucket upload instead.";

/** Shared ICE-state monitoring; promotes the listed states to a terminal failure. No restart-ICE. */
function attachIceMonitoring(
  pc: RTCPeerConnection,
  fail: (reason: string, message: string) => void
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
      case "failed":
        clearTimers();
        fail("ice_failed", FAILURE_MESSAGE);
        break;
      case "disconnected":
        if (!disconnectedTimer) {
          disconnectedTimer = setTimeout(() => {
            if (pc.iceConnectionState === "disconnected")
              fail("ice_failed", FAILURE_MESSAGE);
          }, 10_000);
        }
        break;
      case "checking":
        if (!checkingTimer) {
          checkingTimer = setTimeout(() => {
            if (pc.iceConnectionState === "checking")
              fail("ice_failed", FAILURE_MESSAGE);
          }, 30_000);
        }
        break;
      case "connected":
      case "completed":
        clearTimers();
        break;
    }
  };

  pc.addEventListener("iceconnectionstatechange", onChange);
  return clearTimers;
}

function waitForDrain(dc: RTCDataChannel): Promise<void> {
  if (dc.bufferedAmount < HIGH_WATER) return Promise.resolve();
  return new Promise((resolve, reject) => {
    dc.bufferedAmountLowThreshold = LOW_WATER;
    const timer = setTimeout(() => {
      dc.removeEventListener("bufferedamountlow", onLow);
      reject(new Error("drain_timeout"));
    }, DRAIN_TIMEOUT_MS);
    const onLow = () => {
      clearTimeout(timer);
      dc.removeEventListener("bufferedamountlow", onLow);
      resolve();
    };
    dc.addEventListener("bufferedamountlow", onLow);
  });
}

/** Trigger a browser download for a blob (no folder permission needed). */
function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
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
  private receiverComplete = false;
  private completeResolve: (() => void) | null = null;
  private completeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    transferId: string,
    files: File[],
    iceServers: RTCIceServer[],
    cb: PeerCallbacks
  ) {
    this.transferId = transferId;
    this.files = files;
    this.cb = cb;
    this.total = files.reduce((n, f) => n + f.size, 0);
    this.pc = new RTCPeerConnection({ iceServers });
    this.dc = this.pc.createDataChannel("files", { ordered: true });
    this.dc.binaryType = "arraybuffer";

    this.clearIce = attachIceMonitoring(this.pc, (r, m) => this.fail(r, m));
    this.pc.onicecandidate = (e) => {
      if (e.candidate) cb.sendIce(e.candidate.toJSON());
    };
    this.dc.onopen = () => void this.pump();
    this.dc.onmessage = (ev) => this.onControl(ev.data);
    this.dc.onerror = () =>
      this.fail("datachannel_error", "Transfer interrupted");
  }

  /** Receiver -> sender control channel. Currently only the `ready` ack. */
  private onControl(data: unknown): void {
    if (typeof data !== "string") return;
    let msg: { type?: string };
    try {
      msg = JSON.parse(data) as { type?: string };
    } catch {
      return;
    }
    if (msg.type === "ready") this.markReady();
    else if (msg.type === "complete") this.markComplete();
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
        reject(new Error("receiver_timeout"));
      }, READY_TIMEOUT_MS);
    });
  }

  private markComplete(): void {
    if (this.completeTimer) {
      clearTimeout(this.completeTimer);
      this.completeTimer = null;
    }
    this.receiverComplete = true;
    this.completeResolve?.();
    this.completeResolve = null;
  }

  /**
   * Resolve once the receiver confirms it has written every file (its `complete`
   * ack). Never rejects: an older receiver won't send the ack, and by the time
   * this resolves on timeout the bytes have had ample time to flush — so we can
   * safely close. Closing on local bufferedAmount alone would abort SCTP data
   * still in flight to a slower peer, leaving them with partial / 0-byte files.
   */
  private waitForComplete(): Promise<void> {
    if (this.receiverComplete) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.completeResolve = resolve;
      this.completeTimer = setTimeout(() => {
        this.completeResolve = null;
        this.completeTimer = null;
        resolve();
      }, COMPLETE_TIMEOUT_MS);
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
        mime: f.type || "application/octet-stream",
      })),
    };
    this.dc.send(JSON.stringify(manifest));

    // Wait for the receiver to confirm its sinks are ready before streaming
    // bytes. Without this the receiver can drop early chunks while it is still
    // awaiting save-file pickers / allocating buffers.
    try {
      await this.waitForReady();
    } catch {
      this.fail(
        "receiver_timeout",
        "The other person did not start receiving in time."
      );
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
          this.fail(
            "stalled",
            "Transfer stalled — the connection appears to be stuck."
          );
          return;
        }
      }
    }
    if (this.cancelled) return;
    this.dc.send(JSON.stringify({ type: "done" }));

    // Wait for the receiver to confirm every file landed before tearing down.
    // ICE monitoring stays active during this wait so a genuine mid-transfer
    // drop is still caught as a failure.
    await this.waitForComplete();
    if (this.cancelled) return;

    this.completed = true;
    this.cb.onComplete();
    // Now that the receiver has everything, stop ICE monitoring (so its own
    // teardown can't surface a spurious failure) and close once the channel has
    // flushed.
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
    if (this.completeTimer) {
      clearTimeout(this.completeTimer);
      this.completeTimer = null;
    }
    this.completeResolve = null;
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
  // Stream straight to disk only for a single FSAA save. Multi-file batches are
  // buffered in memory and delivered as one .zip (one save, no per-file
  // prompts), which also lets us ack `ready` instantly so the handshake never
  // stalls behind a pile of save dialogs.
  private streamToDisk = false;
  // Serialize message handling: frames arrive on a concurrent async handler, so
  // without a queue the manifest setup (which awaits save pickers) can race
  // chunk handling, dropping early chunks or interleaving writes.
  private queue: Promise<void> = Promise.resolve();
  // Receiver-chosen base name for the multi-file .zip (sanitized at save time).
  private zipName: string;

  constructor(
    iceServers: RTCIceServer[],
    cb: PeerCallbacks,
    zipName = "handover-files"
  ) {
    this.cb = cb;
    this.zipName = zipName;
    this.useFsaa = isFsaaAvailable();
    this.pc = new RTCPeerConnection({ iceServers });
    this.clearIce = attachIceMonitoring(this.pc, (r, m) => this.fail(r, m));
    this.pc.onicecandidate = (e) => {
      if (e.candidate) cb.sendIce(e.candidate.toJSON());
    };
    this.pc.ondatachannel = (e) => {
      const dc = e.channel;
      this.dc = dc;
      dc.binaryType = "arraybuffer";
      dc.onmessage = (ev) => this.enqueue(ev.data);
      // The sender tears the connection down right after it flushes the final
      // bytes, so both `error` (e.g. SCTP "User-Initiated Abort") and `close`
      // can fire while buffered chunks / the `done` frame are still sitting in
      // our async processing queue. Defer the completeness check to the end of
      // that queue: finish() either completes (all bytes arrived) or fails only
      // when data is genuinely missing — so normal teardown never looks like an
      // interruption.
      dc.onerror = () => this.settleOnTeardown();
      dc.onclose = () => this.settleOnTeardown();
    };
  }

  /**
   * Resolve a channel error/close by deferring to the end of the message queue,
   * so any still-buffered chunks and the `done` frame are processed first. Only
   * fails when the data is genuinely incomplete.
   */
  private settleOnTeardown(): void {
    this.queue = this.queue.then(() => {
      if (this.completed || this.cancelled) return;
      return this.finish();
    });
  }

  /** Append to the serial processing chain so messages are handled in order. */
  private enqueue(data: string | ArrayBuffer): void {
    this.queue = this.queue
      .then(() => this.onMessage(data))
      .catch(() => {
        this.fail("protocol_error", "Transfer failed: malformed data.");
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
    if (typeof data === "string") {
      let msg: { type?: string } & Partial<Manifest>;
      try {
        msg = JSON.parse(data) as { type?: string } & Partial<Manifest>;
      } catch {
        this.fail(
          "protocol_error",
          "Transfer failed: malformed control message."
        );
        return;
      }
      if (msg.type === "done") {
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

    // Single file + FSAA streams to disk (one save dialog, no memory cap).
    // Everything else is buffered and zipped, so it must fit the memory cap.
    this.streamToDisk = this.useFsaa && manifest.files.length === 1;

    if (!this.streamToDisk && this.total > IN_MEMORY_CAP) {
      this.fail(
        "too_large",
        "Files exceed the 1 GB in-memory limit for this browser."
      );
      return;
    }

    if (this.streamToDisk) {
      const meta = manifest.files[0];
      const sink: FileSink = { meta, received: 0, done: false };
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: meta.name,
        });
        sink.writable = await handle.createWritable();
      } catch {
        this.fail("save_cancelled", "Save was cancelled.");
        return;
      }
      this.sinks[meta.index] = sink;
    } else {
      for (const meta of manifest.files) {
        this.sinks[meta.index] = { meta, received: 0, done: false, chunks: [] };
      }
    }

    // Sinks are ready; tell the sender it can start streaming bytes. No user
    // prompts were needed (except the single-file save), so this is immediate.
    try {
      this.dc?.send(JSON.stringify({ type: "ready" }));
    } catch {
      this.fail("connection_interrupted", "Transfer interrupted");
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
      this.fail("size_mismatch", "Received more data than expected.");
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
        this.fail("size_mismatch", "File size did not match.");
        return;
      }
      // Stream-to-disk files commit here; buffered files are materialized once
      // everything has arrived (see flushOutput).
      if (sink.writable) await sink.writable.close();
      sink.done = true;
    }
  }

  /**
   * Materialize buffered files once all bytes have arrived: a single file is
   * saved as-is, multiple files are bundled into one .zip — a single download
   * either way. Stream-to-disk files were already committed in onChunk.
   */
  private async flushOutput(): Promise<void> {
    if (this.streamToDisk) return;
    const sinks = this.sinks.filter(Boolean);
    if (sinks.length === 1) {
      const s = sinks[0];
      saveBlob(
        new Blob((s.chunks ?? []) as BlobPart[], { type: s.meta.mime }),
        s.meta.name
      );
      s.chunks = [];
      return;
    }
    // Disambiguate duplicate names so zip entries don't collide.
    const used = new Map<string, number>();
    const uniqueName = (name: string): string => {
      const seen = used.get(name) ?? 0;
      used.set(name, seen + 1);
      if (seen === 0) return name;
      const dot = name.lastIndexOf(".");
      return dot > 0
        ? `${name.slice(0, dot)} (${seen})${name.slice(dot)}`
        : `${name} (${seen})`;
    };
    const files = sinks.map((s) => ({
      name: uniqueName(s.meta.name),
      input: new Blob((s.chunks ?? []) as BlobPart[], { type: s.meta.mime }),
    }));
    const blob = await downloadZip(files).blob();
    saveBlob(blob, this.zipFileName());
    for (const s of sinks) s.chunks = [];
  }

  /** Sanitize the receiver-chosen name into a safe `<name>.zip` filename. */
  private zipFileName(): string {
    const fallback = "handover-files";
    const base =
      (this.zipName || fallback)
        .trim()
        .replace(/\.zip$/i, "")
        .replace(/[\\/:*?"<>|\x00-\x1f]+/g, "_")
        .slice(0, 120)
        .trim() || fallback;
    return `${base}.zip`;
  }

  private allDone(): boolean {
    return (
      this.manifest !== null &&
      this.sinks.length === this.manifest.files.length &&
      this.sinks.every((s) => s?.done)
    );
  }

  private async finish(): Promise<void> {
    if (this.completed || this.cancelled) return;
    if (!this.allDone()) {
      this.fail("incomplete", "Transfer ended before all files arrived.");
      return;
    }
    // Save the buffered files (zip for multi-file) before declaring success, so
    // the `complete` ack truly means "written to disk".
    try {
      await this.flushOutput();
    } catch {
      this.fail("save_failed", "Could not save the received files.");
      return;
    }
    this.completed = true;
    this.clearIce();
    // Confirm to the sender that every file is written so it can close cleanly
    // instead of aborting SCTP data still in flight (which would truncate the
    // tail files for a slower peer). Best-effort: the sender also has a timeout.
    try {
      this.dc?.send(JSON.stringify({ type: "complete" }));
    } catch {
      /* best effort */
    }
    this.cb.onComplete();
    // Keep the channel open briefly so the ack can flush; the sender normally
    // closes first once it receives it. Fall back so we never leak the peer.
    setTimeout(() => this.close(), RECEIVER_LINGER_MS);
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
