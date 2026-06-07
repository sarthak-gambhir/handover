import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { Server as IOServer } from 'socket.io';
import { io as ioc, type Socket as ClientSocket } from 'socket.io-client';
import { store } from './sessions.js';
import { setIo } from './realtime.js';
import { registerWs } from './ws.js';
import { config } from './config.js';

let httpServer: http.Server;
let io: IOServer;
let port: number;
const clients: ClientSocket[] = [];

beforeAll(async () => {
  httpServer = http.createServer();
  io = new IOServer(httpServer, { path: '/api/ws' });
  setIo(io);
  registerWs(io);
  await new Promise<void>((resolve) => {
    httpServer.listen(0, () => {
      port = (httpServer.address() as { port: number }).port;
      resolve();
    });
  });
});

afterAll(async () => {
  io.close();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

afterEach(() => {
  for (const c of clients) c.disconnect();
  clients.length = 0;
  store.sessions.clear();
  store.tokens.clear();
});

function once<T = any>(socket: ClientSocket, event: string, timeoutMs = 2000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

function connect(slug: string, token: string): ClientSocket {
  const c = ioc(`http://127.0.0.1:${port}`, {
    path: '/api/ws',
    transports: ['polling'],
    forceNew: true,
    reconnection: false,
    extraHeaders: { Cookie: `st_${slug}=${token}` },
  });
  clients.push(c);
  return c;
}

async function identify(c: ClientSocket, slug: string, tabId: string): Promise<void> {
  const snap = once(c, 'state:snapshot');
  c.emit('identify', { slug, tab_id: tabId });
  await snap;
}

/** Build a session with the owner + N admitted members, all connected. */
async function setup() {
  const { session, ownerToken, ownerUserId } = store.createSession();
  const slug = session.slug;
  const a = store.admitKnocker(session, store.addKnocker(session, 'A').knocker.knock_id)!;
  const b = store.admitKnocker(session, store.addKnocker(session, 'B').knocker.knock_id)!;
  const c = store.admitKnocker(session, store.addKnocker(session, 'C').knocker.knock_id)!;

  const oSock = connect(slug, ownerToken);
  const aSock = connect(slug, a.session_token);
  const bSock = connect(slug, b.session_token);
  const cSock = connect(slug, c.session_token);
  await identify(oSock, slug, 'tab-o');
  await identify(aSock, slug, 'tab-a');
  await identify(bSock, slug, 'tab-b');
  await identify(cSock, slug, 'tab-c');

  return {
    slug,
    session,
    ownerUserId,
    A: { id: a.user_id, sock: aSock },
    B: { id: b.user_id, sock: bSock },
    C: { id: c.user_id, sock: cSock },
    O: { id: ownerUserId, sock: oSock },
  };
}

async function request(s: Awaited<ReturnType<typeof setup>>): Promise<string> {
  const recv = once<{ transfer_id: string }>(s.B.sock, 'transfer:request');
  s.A.sock.emit('transfer:request', { to_user_id: s.B.id, files: [{ name: 'f.bin', size: 100 }] });
  return (await recv).transfer_id;
}

async function accept(s: Awaited<ReturnType<typeof setup>>, transfer_id: string): Promise<void> {
  const r = once(s.A.sock, 'transfer:response');
  s.B.sock.emit('transfer:response', { transfer_id, accepted: true });
  await r;
}

async function offer(s: Awaited<ReturnType<typeof setup>>, transfer_id: string): Promise<void> {
  const r = once(s.B.sock, 'webrtc:offer');
  s.A.sock.emit('webrtc:offer', { transfer_id, sdp: 'OFFER' });
  await r;
}

async function answer(s: Awaited<ReturnType<typeof setup>>, transfer_id: string): Promise<void> {
  const r = once(s.A.sock, 'webrtc:answer');
  s.B.sock.emit('webrtc:answer', { transfer_id, sdp: 'ANSWER' });
  await r;
}

describe('signaling state machine', () => {
  beforeEach(() => {
    store.sessions.clear();
    store.tokens.clear();
  });

  it('happy path: requested -> accepted -> offering -> answered -> closed', async () => {
    const s = await setup();
    const transfer_id = await request(s);
    expect(transfer_id).toMatch(/^[0-9a-f]+$/);

    await accept(s, transfer_id);
    await offer(s, transfer_id);
    await answer(s, transfer_id);

    // ICE both directions.
    const iceToB = once(s.B.sock, 'webrtc:ice');
    s.A.sock.emit('webrtc:ice', { transfer_id, candidate: 'cand-1' });
    expect((await iceToB).candidate).toBe('cand-1');

    const iceToA = once(s.A.sock, 'webrtc:ice');
    s.B.sock.emit('webrtc:ice', { transfer_id, candidate: 'cand-2' });
    expect((await iceToA).candidate).toBe('cand-2');

    const closed = once(s.B.sock, 'transfer:closed');
    s.A.sock.emit('transfer:complete', { transfer_id });
    await closed;
    expect(s.session.transfers.get(transfer_id)?.state).toBe('closed');
  });

  it('server issues the transfer_id; the client never proposes one', async () => {
    const s = await setup();
    const recv = once<{ transfer_id: string }>(s.B.sock, 'transfer:request');
    // Client tries to inject its own transfer_id — server ignores it.
    s.A.sock.emit('transfer:request', {
      to_user_id: s.B.id,
      files: [{ name: 'f', size: 1 }],
      transfer_id: 'client-chosen-id',
    });
    const got = await recv;
    expect(got.transfer_id).not.toBe('client-chosen-id');
    expect(s.session.transfers.has(got.transfer_id)).toBe(true);
  });

  it('recipient cannot send webrtc:offer (wrong actor in accepted)', async () => {
    const s = await setup();
    const transfer_id = await request(s);
    await accept(s, transfer_id);
    const err = once<{ code: string }>(s.B.sock, 'error');
    s.B.sock.emit('webrtc:offer', { transfer_id, sdp: 'x' });
    expect((await err).code).toBe('invalid_signaling_state');
  });

  it('sender cannot send webrtc:answer (wrong actor in offering)', async () => {
    const s = await setup();
    const transfer_id = await request(s);
    await accept(s, transfer_id);
    await offer(s, transfer_id);
    const err = once<{ code: string }>(s.A.sock, 'error');
    s.A.sock.emit('webrtc:answer', { transfer_id, sdp: 'x' });
    expect((await err).code).toBe('invalid_signaling_state');
  });

  it('webrtc:answer before webrtc:offer is rejected (bad state)', async () => {
    const s = await setup();
    const transfer_id = await request(s);
    await accept(s, transfer_id);
    const err = once<{ code: string }>(s.B.sock, 'error');
    s.B.sock.emit('webrtc:answer', { transfer_id, sdp: 'x' });
    expect((await err).code).toBe('invalid_signaling_state');
  });

  it('a third member cannot inject signaling for someone else’s transfer', async () => {
    const s = await setup();
    const transfer_id = await request(s);
    const err = once<{ code: string }>(s.C.sock, 'error');
    s.C.sock.emit('transfer:response', { transfer_id, accepted: true });
    expect((await err).code).toBe('invalid_signaling_state');
  });

  it('either peer can cancel in a non-terminal state', async () => {
    const s = await setup();
    const transfer_id = await request(s);
    const cancelled = once<{ by_user_id: string }>(s.B.sock, 'transfer:cancelled');
    s.A.sock.emit('transfer:cancel', { transfer_id, reason: 'changed_mind' });
    expect((await cancelled).by_user_id).toBe(s.A.id);
    expect(s.session.transfers.get(transfer_id)?.state).toBe('cancelled');
  });

  it('per-state timeout transitions to expired and notifies both peers', async () => {
    const s = await setup();
    const transfer_id = await request(s);
    const expA = once(s.A.sock, 'transfer:expired');
    const expB = once(s.B.sock, 'transfer:expired');
    const t = s.session.transfers.get(transfer_id)!;
    const now = Date.now();
    s.session.last_activity = now;
    t.state_changed_at = now - config.transferTimeouts.requested - 1000;
    store.sweep(now);
    await Promise.all([expA, expB]);
    expect(t.state).toBe('expired');
  });
});

describe('peer departure cancels in-flight transfers (G11)', () => {
  beforeEach(() => {
    store.sessions.clear();
    store.tokens.clear();
  });

  it('owner kick during offering cancels the transfer for the other peer', async () => {
    const s = await setup();
    const transfer_id = await request(s);
    await accept(s, transfer_id);
    await offer(s, transfer_id);
    const cancelled = once<{ reason: string }>(s.A.sock, 'transfer:cancelled');
    s.O.sock.emit('kick', { user_id: s.B.id });
    expect((await cancelled).reason).toBe('peer_left');
  });

  it('clean leave during accepted cancels the transfer', async () => {
    const s = await setup();
    const transfer_id = await request(s);
    await accept(s, transfer_id);
    const cancelled = once<{ reason: string }>(s.A.sock, 'transfer:cancelled');
    s.B.sock.emit('leave');
    expect((await cancelled).reason).toBe('peer_left');
  });

  it('disconnect grace expiry during answered cancels the transfer', async () => {
    const s = await setup();
    const transfer_id = await request(s);
    await accept(s, transfer_id);
    await offer(s, transfer_id);
    await answer(s, transfer_id);
    const cancelled = once<{ reason: string }>(s.A.sock, 'transfer:cancelled', 8000);
    s.B.sock.disconnect();
    expect((await cancelled).reason).toBe('peer_left');
  }, 9000);
});

describe('one tab per session', () => {
  beforeEach(() => {
    store.sessions.clear();
    store.tokens.clear();
  });

  it('a second tab with a different tab_id is refused', async () => {
    const { session, ownerToken } = store.createSession();
    const slug = session.slug;
    const c1 = connect(slug, ownerToken);
    await identify(c1, slug, 'tab-1');

    const c2 = connect(slug, ownerToken);
    const err = once<{ code: string }>(c2, 'error');
    c2.emit('identify', { slug, tab_id: 'tab-2' });
    expect((await err).code).toBe('already_open_elsewhere');
  });
});
