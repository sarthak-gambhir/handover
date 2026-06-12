import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import http from "node:http";
import { Server as IOServer } from "socket.io";
import { io as ioc, type Socket as ClientSocket } from "socket.io-client";
import { store } from "./sessions.js";
import { setIo } from "./realtime.js";
import { registerWs } from "./ws.js";
import { config } from "./config.js";

let httpServer: http.Server;
let io: IOServer;
let port: number;
const clients: ClientSocket[] = [];

beforeAll(async () => {
  httpServer = http.createServer();
  io = new IOServer(httpServer, { path: "/api/ws" });
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

function once<T = any>(
  socket: ClientSocket,
  event: string,
  timeoutMs = 2000
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timeout waiting for ${event}`)),
      timeoutMs
    );
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

function connect(slug: string, token: string): ClientSocket {
  const c = ioc(`http://127.0.0.1:${port}`, {
    path: "/api/ws",
    transports: ["polling"],
    forceNew: true,
    reconnection: false,
    extraHeaders: { Cookie: `st_${slug}=${token}` },
  });
  clients.push(c);
  return c;
}

async function identify(
  c: ClientSocket,
  slug: string,
  tabId: string
): Promise<void> {
  const snap = once(c, "state:snapshot");
  c.emit("identify", { slug, tab_id: tabId });
  await snap;
}

/** Build a session with the owner + N admitted members, all connected. */
async function setup() {
  const { session, ownerToken, ownerUserId } = store.createSession();
  const slug = session.slug;
  const a = store.admitKnocker(
    session,
    store.addKnocker(session, "A").knocker.knock_id
  )!;
  const b = store.admitKnocker(
    session,
    store.addKnocker(session, "B").knocker.knock_id
  )!;
  const c = store.admitKnocker(
    session,
    store.addKnocker(session, "C").knocker.knock_id
  )!;

  const oSock = connect(slug, ownerToken);
  const aSock = connect(slug, a.session_token);
  const bSock = connect(slug, b.session_token);
  const cSock = connect(slug, c.session_token);
  await identify(oSock, slug, "tab-o");
  await identify(aSock, slug, "tab-a");
  await identify(bSock, slug, "tab-b");
  await identify(cSock, slug, "tab-c");

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
  const recv = once<{ transfer_id: string }>(s.B.sock, "transfer:request");
  s.A.sock.emit("transfer:request", {
    to_user_id: s.B.id,
    files: [{ name: "f.bin", size: 100 }],
  });
  return (await recv).transfer_id;
}

async function accept(
  s: Awaited<ReturnType<typeof setup>>,
  transfer_id: string
): Promise<void> {
  const r = once(s.A.sock, "transfer:response");
  s.B.sock.emit("transfer:response", { transfer_id, accepted: true });
  await r;
}

async function offer(
  s: Awaited<ReturnType<typeof setup>>,
  transfer_id: string
): Promise<void> {
  const r = once(s.B.sock, "webrtc:offer");
  s.A.sock.emit("webrtc:offer", { transfer_id, sdp: "OFFER" });
  await r;
}

async function answer(
  s: Awaited<ReturnType<typeof setup>>,
  transfer_id: string
): Promise<void> {
  const r = once(s.A.sock, "webrtc:answer");
  s.B.sock.emit("webrtc:answer", { transfer_id, sdp: "ANSWER" });
  await r;
}

describe("signaling state machine", () => {
  beforeEach(() => {
    store.sessions.clear();
    store.tokens.clear();
  });

  it("happy path: requested -> accepted -> offering -> answered -> closed", async () => {
    const s = await setup();
    const transfer_id = await request(s);
    expect(transfer_id).toMatch(/^[0-9a-f]+$/);

    await accept(s, transfer_id);
    await offer(s, transfer_id);
    await answer(s, transfer_id);

    // ICE both directions.
    const iceToB = once(s.B.sock, "webrtc:ice");
    s.A.sock.emit("webrtc:ice", { transfer_id, candidate: "cand-1" });
    expect((await iceToB).candidate).toBe("cand-1");

    const iceToA = once(s.A.sock, "webrtc:ice");
    s.B.sock.emit("webrtc:ice", { transfer_id, candidate: "cand-2" });
    expect((await iceToA).candidate).toBe("cand-2");

    const closed = once(s.B.sock, "transfer:closed");
    s.A.sock.emit("transfer:complete", { transfer_id });
    await closed;
    expect(s.session.transfers.get(transfer_id)?.state).toBe("closed");
  });

  it("server issues the transfer_id; the client never proposes one", async () => {
    const s = await setup();
    const recv = once<{ transfer_id: string }>(s.B.sock, "transfer:request");
    // Client tries to inject its own transfer_id — server ignores it.
    s.A.sock.emit("transfer:request", {
      to_user_id: s.B.id,
      files: [{ name: "f", size: 1 }],
      transfer_id: "client-chosen-id",
    });
    const got = await recv;
    expect(got.transfer_id).not.toBe("client-chosen-id");
    expect(s.session.transfers.has(got.transfer_id)).toBe(true);
  });

  it("recipient cannot send webrtc:offer (wrong actor in accepted)", async () => {
    const s = await setup();
    const transfer_id = await request(s);
    await accept(s, transfer_id);
    const err = once<{ code: string }>(s.B.sock, "error");
    s.B.sock.emit("webrtc:offer", { transfer_id, sdp: "x" });
    expect((await err).code).toBe("invalid_signaling_state");
  });

  it("sender cannot send webrtc:answer (wrong actor in offering)", async () => {
    const s = await setup();
    const transfer_id = await request(s);
    await accept(s, transfer_id);
    await offer(s, transfer_id);
    const err = once<{ code: string }>(s.A.sock, "error");
    s.A.sock.emit("webrtc:answer", { transfer_id, sdp: "x" });
    expect((await err).code).toBe("invalid_signaling_state");
  });

  it("webrtc:answer before webrtc:offer is rejected (bad state)", async () => {
    const s = await setup();
    const transfer_id = await request(s);
    await accept(s, transfer_id);
    const err = once<{ code: string }>(s.B.sock, "error");
    s.B.sock.emit("webrtc:answer", { transfer_id, sdp: "x" });
    expect((await err).code).toBe("invalid_signaling_state");
  });

  it("a third member cannot inject signaling for someone else’s transfer", async () => {
    const s = await setup();
    const transfer_id = await request(s);
    const err = once<{ code: string }>(s.C.sock, "error");
    s.C.sock.emit("transfer:response", { transfer_id, accepted: true });
    expect((await err).code).toBe("invalid_signaling_state");
  });

  it("either peer can cancel in a non-terminal state", async () => {
    const s = await setup();
    const transfer_id = await request(s);
    const cancelled = once<{ by_user_id: string }>(
      s.B.sock,
      "transfer:cancelled"
    );
    s.A.sock.emit("transfer:cancel", { transfer_id, reason: "changed_mind" });
    expect((await cancelled).by_user_id).toBe(s.A.id);
    expect(s.session.transfers.get(transfer_id)?.state).toBe("cancelled");
  });

  it("per-state timeout transitions to expired and notifies both peers", async () => {
    const s = await setup();
    const transfer_id = await request(s);
    const expA = once(s.A.sock, "transfer:expired");
    const expB = once(s.B.sock, "transfer:expired");
    const t = s.session.transfers.get(transfer_id)!;
    const now = Date.now();
    s.session.last_activity = now;
    t.state_changed_at = now - config.transferTimeouts.requested - 1000;
    store.sweep(now);
    await Promise.all([expA, expB]);
    expect(t.state).toBe("expired");
  });
});

describe("peer departure cancels in-flight transfers (G11)", () => {
  beforeEach(() => {
    store.sessions.clear();
    store.tokens.clear();
  });

  it("owner kick during offering cancels the transfer for the other peer", async () => {
    const s = await setup();
    const transfer_id = await request(s);
    await accept(s, transfer_id);
    await offer(s, transfer_id);
    const cancelled = once<{ reason: string }>(s.A.sock, "transfer:cancelled");
    s.O.sock.emit("kick", { user_id: s.B.id });
    expect((await cancelled).reason).toBe("peer_left");
  });

  it("clean leave during accepted cancels the transfer", async () => {
    const s = await setup();
    const transfer_id = await request(s);
    await accept(s, transfer_id);
    const cancelled = once<{ reason: string }>(s.A.sock, "transfer:cancelled");
    s.B.sock.emit("leave");
    expect((await cancelled).reason).toBe("peer_left");
  });

  it("disconnect grace expiry during answered cancels the transfer", async () => {
    const s = await setup();
    const transfer_id = await request(s);
    await accept(s, transfer_id);
    await offer(s, transfer_id);
    await answer(s, transfer_id);
    const cancelled = once<{ reason: string }>(
      s.A.sock,
      "transfer:cancelled",
      8000
    );
    s.B.sock.disconnect();
    expect((await cancelled).reason).toBe("peer_left");
  }, 9000);
});

describe("ownership transfer requires a matching offer", () => {
  beforeEach(() => {
    store.sessions.clear();
    store.tokens.clear();
  });

  it("a member cannot seize ownership without an offer", async () => {
    const s = await setup();
    const err = once<{ code: string }>(s.A.sock, "error");
    s.A.sock.emit("owner_accept");
    expect((await err).code).toBe("no_pending_offer");
    expect(s.session.owner_user_id).toBe(s.O.id);
    expect(s.session.members.get(s.A.id)?.is_owner).toBe(false);
  });

  it("only the offered member can accept (offer to A, B cannot take it)", async () => {
    const s = await setup();
    const offered = once<{ from_user_id: string }>(s.A.sock, "owner_offered");
    s.O.sock.emit("transfer_ownership", { to_user_id: s.A.id });
    await offered;

    const err = once<{ code: string }>(s.B.sock, "error");
    s.B.sock.emit("owner_accept");
    expect((await err).code).toBe("no_pending_offer");
    expect(s.session.owner_user_id).toBe(s.O.id);
  });

  it("the offered member accepts and ownership transfers", async () => {
    const s = await setup();
    const offered = once(s.A.sock, "owner_offered");
    s.O.sock.emit("transfer_ownership", { to_user_id: s.A.id });
    await offered;

    const changed = once<{ new_owner_user_id: string }>(
      s.O.sock,
      "owner:changed"
    );
    s.A.sock.emit("owner_accept");
    expect((await changed).new_owner_user_id).toBe(s.A.id);
    expect(s.session.owner_user_id).toBe(s.A.id);
    expect(s.session.members.get(s.A.id)?.is_owner).toBe(true);
    expect(s.session.members.get(s.O.id)?.is_owner).toBe(false);
    expect(s.session.pending_owner_offer).toBeNull();
  });

  it("an offer expires via the sweeper and can no longer be accepted", async () => {
    const s = await setup();
    const offered = once(s.A.sock, "owner_offered");
    s.O.sock.emit("transfer_ownership", { to_user_id: s.A.id });
    await offered;

    const expiredO = once(s.O.sock, "owner_offer:expired");
    const expiredA = once(s.A.sock, "owner_offer:expired");
    const now = Date.now();
    s.session.last_activity = now;
    s.session.pending_owner_offer!.created_at =
      now - config.ownerOfferTtlMs - 1000;
    store.sweep(now);
    await Promise.all([expiredO, expiredA]);
    expect(s.session.pending_owner_offer).toBeNull();

    const err = once<{ code: string }>(s.A.sock, "error");
    s.A.sock.emit("owner_accept");
    expect((await err).code).toBe("no_pending_offer");
    expect(s.session.owner_user_id).toBe(s.O.id);
  });

  it("a non-owner cannot offer ownership", async () => {
    const s = await setup();
    const err = once<{ code: string }>(s.A.sock, "error");
    s.A.sock.emit("transfer_ownership", { to_user_id: s.B.id });
    expect((await err).code).toBe("owner_only");
    expect(s.session.pending_owner_offer).toBeNull();
  });
});

describe('session freeze ("halt all activity")', () => {
  beforeEach(() => {
    store.sessions.clear();
    store.tokens.clear();
  });

  it("owner freeze broadcasts session:frozen and pauses knocking to the room", async () => {
    const s = await setup();
    const frozenA = once<{ frozen: boolean }>(s.A.sock, "session:frozen");
    const pausedA = once<{ paused: boolean }>(s.A.sock, "knocking:paused");
    s.O.sock.emit("session:set_frozen", { frozen: true });
    expect((await frozenA).frozen).toBe(true);
    expect((await pausedA).paused).toBe(true);
    expect(s.session.frozen).toBe(true);
    expect(s.session.knocking_paused).toBe(true);
  });

  it("a non-owner cannot freeze the session", async () => {
    const s = await setup();
    const err = once<{ code: string }>(s.A.sock, "error");
    s.A.sock.emit("session:set_frozen", { frozen: true });
    expect((await err).code).toBe("owner_only");
    expect(s.session.frozen).toBe(false);
  });

  it("a frozen session rejects transfer:request with session_frozen", async () => {
    const s = await setup();
    s.session.frozen = true;
    const err = once<{ code: string }>(s.A.sock, "error");
    s.A.sock.emit("transfer:request", {
      to_user_id: s.B.id,
      files: [{ name: "f", size: 1 }],
    });
    expect((await err).code).toBe("session_frozen");
  });

  it("a frozen session rejects admit with session_frozen", async () => {
    const s = await setup();
    const knock = store.addKnocker(s.session, "D").knocker;
    s.session.frozen = true;
    const err = once<{ code: string }>(s.O.sock, "error");
    s.O.sock.emit("admit", { knock_id: knock.knock_id });
    expect((await err).code).toBe("session_frozen");
  });

  it("freezing cancels an in-flight transfer for both peers", async () => {
    const s = await setup();
    const transfer_id = await request(s);
    await accept(s, transfer_id);
    const cancelledA = once<{ reason: string }>(s.A.sock, "transfer:cancelled");
    const cancelledB = once<{ reason: string }>(s.B.sock, "transfer:cancelled");
    s.O.sock.emit("session:set_frozen", { frozen: true });
    expect((await cancelledA).reason).toBe("session_frozen");
    expect((await cancelledB).reason).toBe("session_frozen");
    expect(s.session.transfers.get(transfer_id)?.state).toBe("cancelled");
  });

  it("the owner cannot resume knocking while frozen", async () => {
    const s = await setup();
    s.session.frozen = true;
    s.session.knocking_paused = true;
    const err = once<{ code: string }>(s.O.sock, "error");
    s.O.sock.emit("knocking:set_paused", { paused: false });
    expect((await err).code).toBe("session_frozen");
    expect(s.session.knocking_paused).toBe(true);
  });

  it("unfreezing leaves knocking paused for manual re-enable", async () => {
    const s = await setup();
    s.O.sock.emit("session:set_frozen", { frozen: true });
    await once<{ paused: boolean }>(s.A.sock, "knocking:paused");
    expect(s.session.knocking_paused).toBe(true);

    const unfrozen = once<{ frozen: boolean }>(s.A.sock, "session:frozen");
    s.O.sock.emit("session:set_frozen", { frozen: false });
    expect((await unfrozen).frozen).toBe(false);
    // Unfreezing must NOT auto-resume knocking.
    expect(s.session.knocking_paused).toBe(true);
  });
});

describe("owner disconnect grace countdown", () => {
  beforeEach(() => {
    store.sessions.clear();
    store.tokens.clear();
  });

  it("owner drop arms a countdown that an owner reconnect cancels", async () => {
    const s = await setup();
    // After the presence grace, remaining members learn the real deadline.
    const offline = once<{ grace_ms: number }>(s.A.sock, "owner:offline", 9000);
    s.O.sock.disconnect();
    const { grace_ms } = await offline;
    expect(grace_ms).toBeGreaterThan(0);
    expect(grace_ms).toBeLessThanOrEqual(config.ownerGraceMs);
    expect(s.session.owner_disconnected_at).not.toBeNull();
    expect(s.session.owner_grace_timer).not.toBeNull();

    // Owner returns before the deadline -> the pending teardown is cancelled.
    const ownerToken = s.session.members.get(s.O.id)!.session_token;
    const oSock2 = connect(s.slug, ownerToken);
    await identify(oSock2, s.slug, "tab-o");
    expect(s.session.owner_disconnected_at).toBeNull();
    expect(s.session.owner_grace_timer).toBeNull();
  }, 12000);

  it("a snapshot carries owner_grace_ms while the owner is offline", async () => {
    const s = await setup();
    const offline = once(s.A.sock, "owner:offline", 9000);
    s.O.sock.disconnect();
    await offline;

    // A member reconnecting mid-grace must be able to resume the countdown.
    s.A.sock.disconnect();
    const aToken = s.session.members.get(s.A.id)!.session_token;
    const aSock2 = connect(s.slug, aToken);
    const snap = once<{ owner_grace_ms: number | null }>(
      aSock2,
      "state:snapshot"
    );
    aSock2.emit("identify", { slug: s.slug, tab_id: "tab-a" });
    const got = await snap;
    expect(got.owner_grace_ms).not.toBeNull();
    expect(got.owner_grace_ms!).toBeGreaterThan(0);

    // Avoid leaking the armed teardown timer past the test.
    if (s.session.owner_grace_timer) clearTimeout(s.session.owner_grace_timer);
  }, 12000);
});

describe("E2EE key exchange relay", () => {
  beforeEach(() => {
    store.sessions.clear();
    store.tokens.clear();
  });

  it("publishes the pubkey from identify into member projections", async () => {
    const { session, ownerToken } = store.createSession();
    const slug = session.slug;
    const oSock = connect(slug, ownerToken);
    const snapO = once(oSock, "state:snapshot");
    oSock.emit("identify", { slug, tab_id: "tab-o", pubkey: "PUB_OWNER" });
    await snapO;

    const a = store.admitKnocker(
      session,
      store.addKnocker(session, "A").knocker.knock_id
    )!;
    const aSock = connect(slug, a.session_token);
    const snapA = once<{
      members: Array<{ is_owner: boolean; pubkey?: string }>;
    }>(aSock, "state:snapshot");
    aSock.emit("identify", { slug, tab_id: "tab-a", pubkey: "PUB_A" });
    const got = await snapA;
    const owner = got.members.find((m) => m.is_owner);
    expect(owner?.pubkey).toBe("PUB_OWNER");
  });

  it("relays request_key to other members (with from_user_id + pubkey)", async () => {
    const s = await setup();
    const oGot = once<{ from_user_id: string; pubkey: string }>(
      s.O.sock,
      "e2ee:request_key"
    );
    s.A.sock.emit("e2ee:request_key", { pubkey: "PUB_A" });
    const got = await oGot;
    expect(got.from_user_id).toBe(s.A.id);
    expect(got.pubkey).toBe("PUB_A");
  });

  it("routes deliver_key only to the targeted member", async () => {
    const s = await setup();
    let bReceived = false;
    s.B.sock.on("e2ee:key", () => {
      bReceived = true;
    });
    const aKey = once<{
      from_user_id: string;
      from_pubkey: string;
      wrapped: string;
      iv: string;
    }>(s.A.sock, "e2ee:key");
    s.O.sock.emit("e2ee:deliver_key", {
      to_user_id: s.A.id,
      from_pubkey: "PUB_OWNER",
      wrapped: "WRAPPED",
      iv: "IV",
    });
    const got = await aKey;
    expect(got.from_user_id).toBe(s.O.id);
    expect(got.from_pubkey).toBe("PUB_OWNER");
    expect(got.wrapped).toBe("WRAPPED");
    expect(got.iv).toBe("IV");
    // The non-targeted member must not receive the wrapped key.
    await new Promise((r) => setTimeout(r, 100));
    expect(bReceived).toBe(false);
  });
});

describe("one tab per session", () => {
  beforeEach(() => {
    store.sessions.clear();
    store.tokens.clear();
  });

  it("a second tab with a different tab_id is refused", async () => {
    const { session, ownerToken } = store.createSession();
    const slug = session.slug;
    const c1 = connect(slug, ownerToken);
    await identify(c1, slug, "tab-1");

    const c2 = connect(slug, ownerToken);
    const err = once<{ code: string }>(c2, "error");
    c2.emit("identify", { slug, tab_id: "tab-2" });
    expect((await err).code).toBe("already_open_elsewhere");
  });
});
