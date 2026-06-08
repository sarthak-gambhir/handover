import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SenderConnection,
  ReceiverConnection,
  type PeerCallbacks,
} from '../src/lib/webrtc';

// A self-contained fake WebRTC + File System Access environment. Two
// FakeDataChannels are wired peer-to-peer so the real sender/receiver protocol
// (manifest -> ready ack -> framed chunks -> done) runs end to end in process.

const HIGH_WATER = 16 * 1024 * 1024;

let BACKPRESSURE = false;
let pickerDelayMs = 0;
let writeDelayMs = 0;
let ERROR_ON_CLOSE = false;
let captured: Map<string, Uint8Array[]>;

type AnyFn = (...args: any[]) => void;

class FakeDataChannel {
  binaryType = 'blob';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  readyState = 'open';
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  peer: FakeDataChannel | null = null;
  closed = false;
  backpressure = false;
  private listeners = new Map<string, Set<AnyFn>>();

  addEventListener(type: string, cb: AnyFn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(cb);
  }
  removeEventListener(type: string, cb: AnyFn) {
    this.listeners.get(type)?.delete(cb);
  }
  private dispatch(type: string) {
    for (const cb of [...(this.listeners.get(type) ?? [])]) cb();
  }

  send(data: unknown) {
    if (this.closed || !this.peer) return;
    const peer = this.peer;
    if (typeof data === 'string') {
      queueMicrotask(() => peer.onmessage?.({ data }));
      return;
    }
    const u8 = data as Uint8Array;
    const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
    if (this.backpressure) {
      this.bufferedAmount = HIGH_WATER + 1;
      queueMicrotask(() => {
        this.bufferedAmount = 0;
        this.dispatch('bufferedamountlow');
      });
    }
    queueMicrotask(() => peer.onmessage?.({ data: ab }));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 'closed';
    // The close event is asynchronous in real WebRTC: already-sent messages are
    // still delivered first. Defer to a macrotask so queued onmessage handling
    // (and the receiver's promise chain) completes before onclose fires. Some
    // browsers also raise `error` on the peer during this teardown.
    setTimeout(() => this.onclose?.(), 0);
    const peer = this.peer;
    if (peer && !peer.closed) {
      peer.closed = true;
      peer.readyState = 'closed';
      if (ERROR_ON_CLOSE) setTimeout(() => peer.onerror?.(), 0);
      setTimeout(() => peer.onclose?.(), 0);
    }
  }
}

const pcs: FakePeerConnection[] = [];

class FakePeerConnection {
  iceConnectionState = 'new';
  onicecandidate: ((e: { candidate: unknown }) => void) | null = null;
  ondatachannel: ((e: { channel: FakeDataChannel }) => void) | null = null;
  localDc: FakeDataChannel | null = null;
  private linked = false;

  constructor() {
    pcs.push(this);
  }

  createDataChannel(): FakeDataChannel {
    const dc = new FakeDataChannel();
    dc.backpressure = BACKPRESSURE;
    this.localDc = dc;
    return dc;
  }
  createOffer() {
    return Promise.resolve({ type: 'offer', sdp: 'offer-sdp' });
  }
  createAnswer() {
    return Promise.resolve({ type: 'answer', sdp: 'answer-sdp' });
  }
  setLocalDescription() {
    return Promise.resolve();
  }
  setRemoteDescription() {
    // The sender side finishing negotiation is our cue to "connect": deliver a
    // peer datachannel to the receiver and open the sender's channel.
    if (this.localDc && !this.linked) {
      this.linked = true;
      const receiver = pcs.find((p) => p !== this && p.localDc === null);
      if (receiver) {
        const recvDc = new FakeDataChannel();
        recvDc.peer = this.localDc;
        this.localDc.peer = recvDc;
        receiver.ondatachannel?.({ channel: recvDc });
        this.localDc.onopen?.();
      }
    }
    return Promise.resolve();
  }
  addIceCandidate() {
    return Promise.resolve();
  }
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

function fakeFile(name: string, bytes: Uint8Array, mime = 'application/octet-stream'): File {
  return {
    name,
    size: bytes.byteLength,
    type: mime,
    slice(start: number, end: number) {
      const sub = bytes.subarray(start, end);
      return {
        arrayBuffer: () =>
          Promise.resolve(sub.buffer.slice(sub.byteOffset, sub.byteOffset + sub.byteLength)),
      };
    },
  } as unknown as File;
}

function installFsaa() {
  captured = new Map();
  (globalThis as any).window = {
    async showSaveFilePicker({ suggestedName }: { suggestedName: string }) {
      if (pickerDelayMs) await new Promise((r) => setTimeout(r, pickerDelayMs));
      const parts: Uint8Array[] = [];
      captured.set(suggestedName, parts);
      return {
        createWritable: async () => ({
          write: async (chunk: Uint8Array) => {
            if (writeDelayMs) await new Promise((r) => setTimeout(r, writeDelayMs));
            parts.push(new Uint8Array(chunk));
          },
          close: async () => {},
        }),
      };
    },
  };
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

interface TransferResult {
  senderDone: boolean;
  receiverDone: boolean;
  failures: string[];
}

async function runTransfer(files: File[]): Promise<TransferResult> {
  const failures: string[] = [];
  let senderDone = false;
  let receiverDone = false;
  let resolveSender!: () => void;
  let resolveReceiver!: () => void;
  const senderP = new Promise<void>((r) => (resolveSender = r));
  const receiverP = new Promise<void>((r) => (resolveReceiver = r));

  const cbR: PeerCallbacks = {
    sendOffer: () => {},
    sendAnswer: () => {},
    sendIce: () => {},
    onProgress: () => {},
    onComplete: () => {
      receiverDone = true;
      resolveReceiver();
    },
    onFailure: (reason) => {
      failures.push(`receiver:${reason}`);
      resolveReceiver();
    },
  };
  const cbS: PeerCallbacks = {
    sendOffer: () => {},
    sendAnswer: () => {},
    sendIce: () => {},
    onProgress: () => {},
    onComplete: () => {
      senderDone = true;
      resolveSender();
    },
    onFailure: (reason) => {
      failures.push(`sender:${reason}`);
      resolveSender();
    },
  };

  const receiver = new ReceiverConnection([], cbR);
  const sender = new SenderConnection('t1', files, [], cbS);
  cbS.sendOffer = (sdp) => void receiver.acceptOffer(sdp);
  cbR.sendAnswer = (sdp) => void sender.acceptAnswer(sdp);

  await sender.start();
  await Promise.all([senderP, receiverP]);
  return { senderDone, receiverDone, failures };
}

function randomBytes(n: number): Uint8Array {
  const u8 = new Uint8Array(n);
  for (let i = 0; i < n; i++) u8[i] = (i * 31 + 7) & 0xff;
  return u8;
}

beforeEach(() => {
  pcs.length = 0;
  BACKPRESSURE = false;
  pickerDelayMs = 0;
  writeDelayMs = 0;
  ERROR_ON_CLOSE = false;
  (globalThis as any).RTCPeerConnection = FakePeerConnection;
  installFsaa();
});

afterEach(() => {
  delete (globalThis as any).RTCPeerConnection;
  delete (globalThis as any).window;
});

describe('webrtc transfer protocol', () => {
  it('delivers a single multi-chunk file byte-for-byte', async () => {
    // ~3.5 chunks at 16 KB so framing/offset logic is exercised.
    const bytes = randomBytes(57_000);
    const res = await runTransfer([fakeFile('a.bin', bytes)]);

    expect(res.failures).toEqual([]);
    expect(res.senderDone).toBe(true);
    expect(res.receiverDone).toBe(true);
    expect(concat(captured.get('a.bin')!)).toEqual(bytes);
  });

  it('delivers multiple files in order with correct contents', async () => {
    const a = randomBytes(20_000);
    const b = randomBytes(40);
    const c = randomBytes(33_000);
    const res = await runTransfer([
      fakeFile('a.bin', a),
      fakeFile('b.bin', b),
      fakeFile('c.bin', c),
    ]);

    expect(res.failures).toEqual([]);
    expect(concat(captured.get('a.bin')!)).toEqual(a);
    expect(concat(captured.get('b.bin')!)).toEqual(b);
    expect(concat(captured.get('c.bin')!)).toEqual(c);
  });

  it('drops no early chunks when the save picker resolves slowly (serialized + ready ack)', async () => {
    pickerDelayMs = 25;
    const bytes = randomBytes(50_000);
    const res = await runTransfer([fakeFile('slow.bin', bytes)]);

    expect(res.failures).toEqual([]);
    expect(concat(captured.get('slow.bin')!)).toEqual(bytes);
  });

  it('does not spuriously fail when the channel closes while writes are still draining', async () => {
    // The sender closes the data channel right after flushing `done`, so the
    // close event can land before the receiver has finished processing its
    // queued chunks. The receiver must defer its completeness check to the end
    // of the queue rather than failing with `connection_interrupted`.
    writeDelayMs = 5;
    const bytes = randomBytes(50_000);
    const res = await runTransfer([fakeFile('drain.bin', bytes)]);

    expect(res.failures).toEqual([]);
    expect(res.receiverDone).toBe(true);
    expect(concat(captured.get('drain.bin')!)).toEqual(bytes);
  });

  it('does not spuriously fail when the channel raises error+close during teardown', async () => {
    // Browsers often fire `error` (e.g. SCTP "User-Initiated Abort") on the
    // receiver as the sender tears down, right after the last bytes land. With
    // slow writes still draining, that must not flip a saved file to failed.
    ERROR_ON_CLOSE = true;
    writeDelayMs = 5;
    const bytes = randomBytes(50_000);
    const res = await runTransfer([fakeFile('teardown.bin', bytes)]);

    expect(res.failures).toEqual([]);
    expect(res.receiverDone).toBe(true);
    expect(concat(captured.get('teardown.bin')!)).toEqual(bytes);
  });

  it('completes correctly while backpressure pauses and resumes the sender', async () => {
    BACKPRESSURE = true;
    const bytes = randomBytes(80_000);
    const res = await runTransfer([fakeFile('bp.bin', bytes)]);

    expect(res.failures).toEqual([]);
    expect(res.senderDone).toBe(true);
    expect(res.receiverDone).toBe(true);
    expect(concat(captured.get('bp.bin')!)).toEqual(bytes);
  });
});
