import type { Server, Socket, DefaultEventsMap } from "socket.io";
import { parse as parseCookie } from "cookie";
import { store } from "./sessions.js";
import { normalizeSlug } from "./slug.js";
import { config } from "./config.js";
import { room, emitActivity } from "./realtime.js";
import { cookieName } from "./auth.js";
import {
  type Session,
  type Member,
  type TransferState,
  type TransferStateName,
  type TransferFileMeta,
  type ActivityOutcome,
  TERMINAL_STATES,
} from "./types.js";

interface SocketData {
  slug: string;
  role: "member" | "pending";
  user_id?: string; // when member
  knock_id?: string; // when pending
  tab_id?: string;
}

type AppSocket = Socket<
  DefaultEventsMap,
  DefaultEventsMap,
  DefaultEventsMap,
  SocketData
>;

const MAX_TRANSFER_FILES = 32;

// Per-event payload size limits (defence in depth on top of maxHttpBufferSize).
const MAX_SDP_BYTES = 64 * 1024;
const MAX_ICE_BYTES = 8 * 1024;

/** Rough serialized size of a signaling payload value. */
function approxBytes(v: unknown): number {
  if (typeof v === "string") return v.length;
  try {
    return JSON.stringify(v).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function denyOwnerAction(socket: AppSocket): void {
  socket.emit("error", {
    code: "owner_only",
    message: "owner action not permitted",
  });
}

// When the session is frozen ("compromised"), reject any activity that adds,
// removes, or moves data. Returns true (and notifies the caller) when blocked.
function frozenBlocked(socket: AppSocket): boolean {
  const data = socket.data;
  if (!data || data.role !== "member") return false;
  const session = store.getSession(data.slug);
  if (session?.frozen) {
    socket.emit("error", {
      code: "session_frozen",
      message: "session is frozen",
    });
    return true;
  }
  return false;
}

// transfer:request rate limit — 20/min/sender (sliding window).
const requestTimestamps = new Map<string, number[]>();
function allowTransferRequest(user_id: string): boolean {
  const now = Date.now();
  const arr = (requestTimestamps.get(user_id) ?? []).filter(
    (t) => now - t < 60_000
  );
  if (arr.length >= 20) {
    requestTimestamps.set(user_id, arr);
    return false;
  }
  arr.push(now);
  requestTimestamps.set(user_id, arr);
  return true;
}

/** Drop a departed user's rate-limit bucket so the map can't grow unbounded. */
function forgetTransferRate(user_id: string): void {
  requestTimestamps.delete(user_id);
}

/** Periodically evict fully-stale buckets (covers users lost to session timeouts). */
function pruneTransferRates(now: number = Date.now()): void {
  for (const [uid, arr] of requestTimestamps) {
    if (arr.every((t) => now - t >= 60_000)) requestTimestamps.delete(uid);
  }
}

function logTransfer(
  session: Session,
  transfer: TransferState,
  from: TransferStateName
): void {
  const log = transfer.state_log;
  const prev = log.length >= 2 ? log[log.length - 2].at : transfer.created_at;
  const ms = Date.now() - prev;
  console.log(
    `[transfer] ${session.slug} ${transfer.transfer_id} ${from}->${transfer.state} (+${ms}ms)`
  );
}

function memberByUserId(session: Session, user_id: string): Member | undefined {
  return session.members.get(user_id);
}

/** Record + broadcast a terminal P2P transfer as an activity entry. */
function recordTransferActivity(
  session: Session,
  transfer: TransferState,
  outcome: ActivityOutcome
): void {
  const from = memberByUserId(session, transfer.from_user_id);
  const to = memberByUserId(session, transfer.to_user_id);
  const entry = store.recordActivity(session, {
    type: "transfer",
    actor_user_id: transfer.from_user_id,
    actor_name: from?.display_name ?? "Former member",
    target_user_id: transfer.to_user_id,
    target_name: to?.display_name ?? "Former member",
    files: transfer.files.map((f) => ({ name: f.name, size: f.size })),
    total_bytes: transfer.files.reduce((n, f) => n + (f.size || 0), 0),
    outcome,
  });
  emitActivity(session, entry);
}

function emitTo(
  io: Server,
  member: Member | undefined,
  event: string,
  payload: unknown
): void {
  if (member?.socket_id) io.to(member.socket_id).emit(event, payload);
}

function broadcastMembers(io: Server, session: Session): void {
  io.to(room(session.slug)).emit("members:list", {
    members: store.publicMembers(session),
  });
}

export function registerWs(io: Server): void {
  // Evict stale transfer rate-limit buckets so the map can't leak as users
  // come and go (including those removed by session/idle timeouts).
  const ratePrune = setInterval(() => pruneTransferRates(), 5 * 60_000);
  if (typeof ratePrune.unref === "function") ratePrune.unref();

  // Sweeper-driven broadcasts.
  store.on("knock:expired", ({ slug, knock_id, socket_id }) => {
    const session = store.getSession(slug);
    if (session) {
      const owner = session.members.get(session.owner_user_id);
      emitTo(io, owner, "knock:expired", { knock_id });
    }
    if (socket_id) io.to(socket_id).emit("knock:expired", { knock_id });
  });

  store.on("session:ended", ({ slug, reason }) => {
    io.to(room(slug)).emit("session:ended", { reason });
    // Disconnect everyone in the room.
    io.in(room(slug)).disconnectSockets(true);
  });

  store.on("transfer:expired", ({ slug, transfer }) => {
    const session = store.getSession(slug);
    if (!session) return;
    const payload = { transfer_id: transfer.transfer_id };
    emitTo(
      io,
      memberByUserId(session, transfer.from_user_id),
      "transfer:expired",
      payload
    );
    emitTo(
      io,
      memberByUserId(session, transfer.to_user_id),
      "transfer:expired",
      payload
    );
  });

  store.on("owner_offer:expired", ({ slug, to_user_id, from_user_id }) => {
    const session = store.getSession(slug);
    if (!session) return;
    emitTo(io, memberByUserId(session, from_user_id), "owner_offer:expired", {
      to_user_id,
    });
    emitTo(io, memberByUserId(session, to_user_id), "owner_offer:expired", {
      to_user_id,
    });
  });

  io.on("connection", (socket: AppSocket) => {
    socket.on(
      "identify",
      (payload: { slug?: string; tab_id?: string; pubkey?: string }) => {
        handleIdentify(io, socket, payload);
      }
    );

    // ---- owner-only events ----
    socket.on("admit", (p: { knock_id?: string }) =>
      handleAdmit(io, socket, p)
    );
    socket.on("reject", (p: { knock_id?: string }) =>
      handleReject(io, socket, p)
    );
    socket.on("kick", (p: { user_id?: string }) => handleKick(io, socket, p));
    socket.on("knocking:set_paused", (p: { paused?: boolean }) =>
      handlePause(io, socket, p)
    );
    socket.on("session:set_frozen", (p: { frozen?: boolean }) =>
      handleSetFrozen(io, socket, p)
    );
    socket.on("session:set_read_only", (p: { read_only?: boolean }) =>
      handleSetReadOnly(io, socket, p)
    );
    socket.on("transfer_ownership", (p: { to_user_id?: string }) =>
      handleOwnershipOffer(io, socket, p)
    );
    socket.on("owner_accept", () => handleOwnerAccept(io, socket));
    socket.on("owner_decline", () => handleOwnerDecline(io, socket));

    // ---- moderation ----
    socket.on(
      "member:restrict",
      (p: { user_id?: string; restrict?: boolean }) =>
        handleRestrict(io, socket, p)
    );
    socket.on("member:report", (p: { user_id?: string; reason?: string }) =>
      handleReport(io, socket, p)
    );
    socket.on("member:block", (p: { user_id?: string; blocked?: boolean }) =>
      handleBlock(io, socket, p)
    );
    socket.on("report:dismiss", (p: { user_id?: string }) =>
      handleReportDismiss(io, socket, p)
    );

    // ---- signaling ----
    socket.on(
      "transfer:request",
      (p: { to_user_id?: string; files?: TransferFileMeta[] }) =>
        handleTransferRequest(io, socket, p)
    );
    socket.on(
      "transfer:response",
      (p: { transfer_id?: string; accepted?: boolean; selected?: number[] }) =>
        handleTransferResponse(io, socket, p)
    );
    socket.on("webrtc:offer", (p: { transfer_id?: string; sdp?: unknown }) =>
      handleOffer(io, socket, p)
    );
    socket.on("webrtc:answer", (p: { transfer_id?: string; sdp?: unknown }) =>
      handleAnswer(io, socket, p)
    );
    socket.on(
      "webrtc:ice",
      (p: { transfer_id?: string; candidate?: unknown }) =>
        handleIce(io, socket, p)
    );
    socket.on(
      "transfer:cancel",
      (p: { transfer_id?: string; reason?: string }) =>
        handleTransferCancel(io, socket, p)
    );
    socket.on("transfer:complete", (p: { transfer_id?: string }) =>
      handleTransferComplete(io, socket, p)
    );

    // ---- E2EE key exchange (relay only) ----
    socket.on("e2ee:request_key", (p: { pubkey?: string }) =>
      handleE2eeRequestKey(socket, p)
    );
    socket.on(
      "e2ee:deliver_key",
      (p: {
        to_user_id?: string;
        from_pubkey?: string;
        wrapped?: string;
        iv?: string;
      }) => handleE2eeDeliverKey(io, socket, p)
    );

    socket.on("leave", (ack?: () => void) => handleLeave(io, socket, ack));
    socket.on("disconnect", () => handleDisconnect(io, socket));
  });
}

// ---- identify --------------------------------------------------------------

function resolveCookieToken(
  socket: AppSocket,
  slug: string
): string | undefined {
  const raw = socket.handshake.headers.cookie;
  if (!raw) return undefined;
  const cookies = parseCookie(raw);
  return cookies[cookieName(slug)];
}

function handleIdentify(
  io: Server,
  socket: AppSocket,
  payload: { slug?: string; tab_id?: string; pubkey?: string }
): void {
  const slug = normalizeSlug(payload.slug ?? "");
  const tab_id = payload.tab_id;
  if (!slug || !tab_id) {
    socket.emit("error", {
      code: "bad_identify",
      message: "slug and tab_id required",
    });
    return;
  }
  const session = store.getSession(slug);
  if (!session) {
    socket.emit("error", {
      code: "session_not_found",
      message: "no such session",
    });
    return;
  }
  const token = resolveCookieToken(socket, slug);
  const entry = store.lookupToken(token);
  if (!entry || entry.slug !== slug) {
    socket.emit("error", {
      code: "unauthorized",
      message: "no valid session cookie",
    });
    return;
  }

  if (entry.status === "pending") {
    // Waiting-screen socket: bind so admit/reject/expire can route here.
    const knocker = session.knockers.get(entry.knock_id);
    if (!knocker) {
      socket.emit("error", {
        code: "unauthorized",
        message: "knock no longer pending",
      });
      return;
    }
    knocker.socket_id = socket.id;
    socket.data = { slug, role: "pending", knock_id: entry.knock_id, tab_id };
    socket.emit("waiting", { knock_id: entry.knock_id });
    return;
  }

  // Member identify.
  const member = session.members.get(entry.user_id);
  if (!member) {
    socket.emit("error", { code: "unauthorized", message: "member not found" });
    return;
  }

  // One-tab enforcement.
  if (member.socket_id && member.tab_id && member.tab_id !== tab_id) {
    const existing = io.sockets.sockets.get(member.socket_id);
    if (existing && existing.connected) {
      socket.emit("error", {
        code: "already_open_elsewhere",
        message: "This session is already open in another tab.",
      });
      socket.disconnect(true);
      return;
    }
  }

  // Same tab (reconnect) or fresh bind. Replace any stale socket binding.
  if (member.offline_grace_timer) {
    clearTimeout(member.offline_grace_timer);
    member.offline_grace_timer = null;
  }
  if (member.socket_id && member.socket_id !== socket.id) {
    io.sockets.sockets.get(member.socket_id)?.disconnect(true);
  }
  member.socket_id = socket.id;
  member.tab_id = tab_id;
  member.last_seen = Date.now();
  // Record the member's published ECDH public key so peers can wrap the bucket
  // content key for them. Bounded to avoid unbounded memory from a bad client.
  if (typeof payload.pubkey === "string" && payload.pubkey.length <= 4096) {
    member.pubkey = payload.pubkey;
  }
  if (member.is_owner) {
    session.owner_disconnected_at = null;
    // Cancel the pending teardown — the owner is back. Clients clear their
    // countdown off the subsequent member:online broadcast below.
    if (session.owner_grace_timer) {
      clearTimeout(session.owner_grace_timer);
      session.owner_grace_timer = null;
    }
  }

  socket.data = { slug, role: "member", user_id: member.user_id, tab_id };
  socket.join(room(slug));
  store.touch(session);

  // If the owner is mid-grace, hand the joiner/reconnector the remaining time
  // so they can resume the countdown (they missed the owner:offline broadcast).
  const owner_grace_ms =
    session.owner_disconnected_at !== null
      ? Math.max(
          0,
          session.owner_disconnected_at + config.ownerGraceMs - Date.now()
        )
      : null;

  socket.emit("state:snapshot", {
    slug: session.slug,
    your_user_id: member.user_id,
    owner_user_id: session.owner_user_id,
    knocking_paused: session.knocking_paused,
    frozen: session.frozen,
    read_only: session.read_only,
    members: store.publicMembers(session),
    bucket: store.publicBucket(session),
    owner_grace_ms,
    your_restricted: [...member.restricted_user_ids],
    // Only the owner moderates, so the reports queue is owner-only.
    reports: member.is_owner ? store.publicReports(session) : [],
    activity: store.activityFor(session, member.user_id),
  });
  io.to(room(slug)).emit("member:online", { user_id: member.user_id });
  broadcastMembers(io, session);
}

// ---- E2EE key exchange (relay only) ----------------------------------------

const MAX_PUBKEY_BYTES = 4096;
const MAX_WRAPPED_BYTES = 4096;

function getMemberContext(
  socket: AppSocket
): { session: Session; member: Member } | null {
  const data = socket.data;
  if (!data || data.role !== "member" || !data.user_id) return null;
  const session = store.getSession(data.slug);
  if (!session) return null;
  const member = session.members.get(data.user_id);
  if (!member) return null;
  return { session, member };
}

// A joining member asks the room for the bucket content key. We relay the
// request (with their public key) to everyone else; any current key-holder
// answers via e2ee:deliver_key. The server never sees the symmetric key.
function handleE2eeRequestKey(socket: AppSocket, p: { pubkey?: string }): void {
  const ctx = getMemberContext(socket);
  if (!ctx) return;
  if (typeof p.pubkey !== "string" || p.pubkey.length > MAX_PUBKEY_BYTES)
    return;
  ctx.member.pubkey = p.pubkey;
  socket.to(room(ctx.session.slug)).emit("e2ee:request_key", {
    from_user_id: ctx.member.user_id,
    pubkey: p.pubkey,
  });
}

// A key-holder hands the (already wrapped-for-recipient) content key back to a
// specific member. We only route the opaque blob to the target's socket.
function handleE2eeDeliverKey(
  io: Server,
  socket: AppSocket,
  p: {
    to_user_id?: string;
    from_pubkey?: string;
    wrapped?: string;
    iv?: string;
  }
): void {
  const ctx = getMemberContext(socket);
  if (!ctx) return;
  if (
    !p.to_user_id ||
    typeof p.from_pubkey !== "string" ||
    typeof p.wrapped !== "string" ||
    typeof p.iv !== "string" ||
    p.from_pubkey.length > MAX_PUBKEY_BYTES ||
    p.wrapped.length > MAX_WRAPPED_BYTES ||
    p.iv.length > 256
  )
    return;
  const target = ctx.session.members.get(p.to_user_id);
  if (!target || !target.socket_id) return;
  io.to(target.socket_id).emit("e2ee:key", {
    from_user_id: ctx.member.user_id,
    from_pubkey: p.from_pubkey,
    wrapped: p.wrapped,
    iv: p.iv,
  });
}

// ---- owner: admit / reject -------------------------------------------------

function getOwnerContext(
  socket: AppSocket
): { session: Session; owner: Member } | null {
  const data = socket.data;
  if (!data || data.role !== "member" || !data.user_id) return null;
  const session = store.getSession(data.slug);
  if (!session) return null;
  const owner = session.members.get(data.user_id);
  if (!owner || !owner.is_owner) return null;
  return { session, owner };
}

function handleAdmit(
  io: Server,
  socket: AppSocket,
  p: { knock_id?: string }
): void {
  if (frozenBlocked(socket)) return;
  const ctx = getOwnerContext(socket);
  if (!ctx) {
    denyOwnerAction(socket);
    return;
  }
  if (!p.knock_id) return;
  const { session } = ctx;
  const knocker = session.knockers.get(p.knock_id);
  if (!knocker) {
    socket.emit("error", { code: "knock_not_found", message: "no such knock" });
    return;
  }
  const waitingSocketId = knocker.socket_id;

  const member = store.admitKnocker(session, p.knock_id);
  if (!member) return;

  if (waitingSocketId) {
    io.to(waitingSocketId).emit("admitted", {
      user_id: member.user_id,
      owner_user_id: session.owner_user_id,
      members: store.publicMembers(session),
      bucket: store.publicBucket(session),
    });
  }
  io.to(room(session.slug)).emit("member:joined", {
    member: store.publicMember(member, session),
  });
  broadcastMembers(io, session);
  // Clear the resolved knock from the owner's queue.
  emitTo(io, ctx.owner, "knock:cancelled", { knock_id: p.knock_id });
  const joinEntry = store.recordActivity(session, {
    type: "join",
    actor_user_id: member.user_id,
    actor_name: member.display_name,
  });
  emitActivity(session, joinEntry);
}

function handleReject(
  io: Server,
  socket: AppSocket,
  p: { knock_id?: string }
): void {
  if (frozenBlocked(socket)) return;
  const ctx = getOwnerContext(socket);
  if (!ctx) {
    denyOwnerAction(socket);
    return;
  }
  if (!p.knock_id) return;
  const knocker = store.removeKnocker(ctx.session, p.knock_id);
  if (knocker?.socket_id) io.to(knocker.socket_id).emit("rejected", {});
  // Clear the resolved knock from the owner's queue.
  emitTo(io, ctx.owner, "knock:cancelled", { knock_id: p.knock_id });
}

// ---- owner: kick -----------------------------------------------------------

function handleKick(
  io: Server,
  socket: AppSocket,
  p: { user_id?: string }
): void {
  const ctx = getOwnerContext(socket);
  if (!ctx) {
    denyOwnerAction(socket);
    return;
  }
  if (!p.user_id) return;
  const { session } = ctx;
  if (p.user_id === session.owner_user_id) return; // can't kick the owner
  const target = session.members.get(p.user_id);
  if (!target) {
    socket.emit("error", {
      code: "member_not_found",
      message: "no such member",
    });
    return;
  }

  const targetSocketId = target.socket_id;
  const targetName = target.display_name;

  // Collect this member's bucket file ids before removal.
  const fileIds = [...session.bucket.values()]
    .filter((e) => e.uploader_id === p.user_id)
    .map((e) => e.id);

  // Cancel in-flight transfers, notify the other peers.
  const cancelled = store.cancelTransfersForUser(session, p.user_id);

  // Remove the member (also purges token + deletes their bucket files).
  store.removeMember(session, p.user_id);
  forgetTransferRate(p.user_id);

  for (const id of fileIds)
    io.to(room(session.slug)).emit("file:removed", { id });
  for (const { transfer, other_user_id } of cancelled) {
    emitTo(io, memberByUserId(session, other_user_id), "transfer:cancelled", {
      transfer_id: transfer.transfer_id,
      by_user_id: p.user_id,
      reason: "peer_left",
    });
  }

  if (targetSocketId) {
    io.to(targetSocketId).emit("kicked", { reason: "removed_by_owner" });
    io.sockets.sockets.get(targetSocketId)?.disconnect(true);
  }
  broadcastMembers(io, session);
  // The kicked member is dropped from the reports queue (as target/reporter).
  emitReports(io, session);
  const kickEntry = store.recordActivity(session, {
    type: "kick",
    actor_user_id: ctx.owner.user_id,
    actor_name: ctx.owner.display_name,
    target_user_id: p.user_id,
    target_name: targetName,
  });
  emitActivity(session, kickEntry);
}

// ---- moderation: restrict / report / block --------------------------------

/** Cancel non-terminal transfers matching a predicate; notify both peers. */
function cancelTransfersWhere(
  io: Server,
  session: Session,
  by_user_id: string,
  reason: string,
  match: (t: TransferState) => boolean
): void {
  for (const transfer of session.transfers.values()) {
    if (TERMINAL_STATES.has(transfer.state)) continue;
    if (!match(transfer)) continue;
    store.setTransferState(transfer, "cancelled");
    for (const uid of [transfer.from_user_id, transfer.to_user_id]) {
      emitTo(io, memberByUserId(session, uid), "transfer:cancelled", {
        transfer_id: transfer.transfer_id,
        by_user_id,
        reason,
      });
    }
  }
}

/** Send the caller their current personal restrict list. */
function emitRestrictList(socket: AppSocket, member: Member): void {
  socket.emit("member:restricted", {
    restricted_user_ids: [...member.restricted_user_ids],
  });
}

/** Push the reports queue to the owner's socket. */
function emitReports(io: Server, session: Session): void {
  const owner = session.members.get(session.owner_user_id);
  emitTo(io, owner, "reports:list", { reports: store.publicReports(session) });
}

// Any member may restrict another: that member can no longer P2P-send to them.
function handleRestrict(
  io: Server,
  socket: AppSocket,
  p: { user_id?: string; restrict?: boolean }
): void {
  const ctx = getMemberContext(socket);
  if (!ctx || !p.user_id) return;
  const { session, member } = ctx;
  if (p.user_id === member.user_id) return; // can't restrict yourself
  if (p.user_id === session.owner_user_id) return; // owner is the trust anchor
  const restrict = Boolean(p.restrict);
  if (restrict) {
    member.restricted_user_ids.add(p.user_id);
    // Drop any in-flight send from the restricted member to me.
    cancelTransfersWhere(
      io,
      session,
      member.user_id,
      "restricted",
      (t) => t.from_user_id === p.user_id && t.to_user_id === member.user_id
    );
  } else {
    member.restricted_user_ids.delete(p.user_id);
  }
  emitRestrictList(socket, member);
  const target = session.members.get(p.user_id);
  const restrictEntry = store.recordActivity(session, {
    type: restrict ? "restrict" : "unrestrict",
    actor_user_id: member.user_id,
    actor_name: member.display_name,
    target_user_id: p.user_id,
    target_name: target?.display_name ?? "Member",
  });
  emitActivity(session, restrictEntry);
}

// Any member may report another. Reporting auto-restricts the target for the
// reporter and surfaces the member in the owner's reports queue.
function handleReport(
  io: Server,
  socket: AppSocket,
  p: { user_id?: string; reason?: string }
): void {
  const ctx = getMemberContext(socket);
  if (!ctx || !p.user_id) return;
  const { session, member } = ctx;
  if (p.user_id === member.user_id) return; // can't report yourself
  if (p.user_id === session.owner_user_id) return; // owner moderates; not reportable
  const target = session.members.get(p.user_id);
  if (!target) {
    socket.emit("error", {
      code: "member_not_found",
      message: "no such member",
    });
    return;
  }
  const reason =
    typeof p.reason === "string" && p.reason.trim()
      ? p.reason.trim().slice(0, 500)
      : undefined;
  store.addReport(session, p.user_id, member.user_id, reason);
  // Auto-restrict: the reporter stops receiving from the reported member.
  member.restricted_user_ids.add(p.user_id);
  cancelTransfersWhere(
    io,
    session,
    member.user_id,
    "restricted",
    (t) => t.from_user_id === p.user_id && t.to_user_id === member.user_id
  );
  emitRestrictList(socket, member);
  emitReports(io, session);
  const reportEntry = store.recordActivity(session, {
    type: "report",
    actor_user_id: member.user_id,
    actor_name: member.display_name,
    target_user_id: p.user_id,
    target_name: target.display_name,
  });
  emitActivity(session, reportEntry);
}

// Owner-only: block bars a member from P2P-sending to anyone and from bucket
// uploads. Reversible. Blocked members may still receive and download.
function handleBlock(
  io: Server,
  socket: AppSocket,
  p: { user_id?: string; blocked?: boolean }
): void {
  const ctx = getOwnerContext(socket);
  if (!ctx) {
    denyOwnerAction(socket);
    return;
  }
  if (!p.user_id) return;
  const { session } = ctx;
  if (p.user_id === session.owner_user_id) return; // can't block the owner
  const target = session.members.get(p.user_id);
  if (!target) {
    socket.emit("error", {
      code: "member_not_found",
      message: "no such member",
    });
    return;
  }
  const blocked = Boolean(p.blocked);
  if (blocked) {
    session.blocked_user_ids.add(p.user_id);
    // Drop any in-flight sends originating from the blocked member.
    cancelTransfersWhere(
      io,
      session,
      ctx.owner.user_id,
      "sender_blocked",
      (t) => t.from_user_id === p.user_id
    );
    // Let the blocked member know immediately (best-effort toast).
    if (target.socket_id) {
      io.to(target.socket_id).emit("error", {
        code: "sender_blocked",
        message: "The owner has blocked you from sending files.",
      });
    }
  } else {
    session.blocked_user_ids.delete(p.user_id);
  }
  store.touch(session);
  broadcastMembers(io, session);
  const blockEntry = store.recordActivity(session, {
    type: blocked ? "block" : "unblock",
    actor_user_id: ctx.owner.user_id,
    actor_name: ctx.owner.display_name,
    target_user_id: p.user_id,
    target_name: target.display_name,
  });
  emitActivity(session, blockEntry);
}

// Owner-only: dismiss ("ignore") a reported member. The reporter's personal
// restrict is intentionally left in place.
function handleReportDismiss(
  io: Server,
  socket: AppSocket,
  p: { user_id?: string }
): void {
  const ctx = getOwnerContext(socket);
  if (!ctx) {
    denyOwnerAction(socket);
    return;
  }
  if (!p.user_id) return;
  store.dismissReport(ctx.session, p.user_id);
  emitReports(io, ctx.session);
}

// ---- owner: pause knocking -------------------------------------------------

function handlePause(
  io: Server,
  socket: AppSocket,
  p: { paused?: boolean }
): void {
  // While frozen, knocking stays locked shut — the owner can't resume it until
  // the session is unfrozen (and then must re-enable knocking manually).
  if (frozenBlocked(socket)) return;
  const ctx = getOwnerContext(socket);
  if (!ctx) {
    denyOwnerAction(socket);
    return;
  }
  ctx.session.knocking_paused = Boolean(p.paused);
  // Broadcast to the whole room so every client reflects the pause state, not
  // just the owner's own tab.
  io.to(room(ctx.session.slug)).emit("knocking:paused", {
    paused: ctx.session.knocking_paused,
  });
}

// ---- owner: freeze ("session compromised") ---------------------------------

function handleSetFrozen(
  io: Server,
  socket: AppSocket,
  p: { frozen?: boolean }
): void {
  const ctx = getOwnerContext(socket);
  if (!ctx) {
    denyOwnerAction(socket);
    return;
  }
  const { session } = ctx;
  const next = Boolean(p.frozen);
  const wasFrozen = session.frozen;
  session.frozen = next;
  store.touch(session);
  io.to(room(session.slug)).emit("session:frozen", { frozen: next });

  // Freezing also slams the door shut: cancel in-flight transfers and pause
  // knocking. Resuming does NOT auto-reopen knocking — the owner re-enables it.
  if (next && !wasFrozen) {
    const cancelled = store.cancelAllTransfers(session);
    for (const { transfer, from_user_id, to_user_id } of cancelled) {
      emitTo(io, memberByUserId(session, from_user_id), "transfer:cancelled", {
        transfer_id: transfer.transfer_id,
        by_user_id: ctx.owner.user_id,
        reason: "session_frozen",
      });
      emitTo(io, memberByUserId(session, to_user_id), "transfer:cancelled", {
        transfer_id: transfer.transfer_id,
        by_user_id: ctx.owner.user_id,
        reason: "session_frozen",
      });
    }
    if (!session.knocking_paused) {
      session.knocking_paused = true;
      io.to(room(session.slug)).emit("knocking:paused", { paused: true });
    }
  }
}

// ---- owner: read-only mode -------------------------------------------------

function handleSetReadOnly(
  io: Server,
  socket: AppSocket,
  p: { read_only?: boolean }
): void {
  const ctx = getOwnerContext(socket);
  if (!ctx) {
    denyOwnerAction(socket);
    return;
  }
  const { session } = ctx;
  const next = Boolean(p.read_only);
  const wasReadOnly = session.read_only;
  session.read_only = next;
  store.touch(session);
  io.to(room(session.slug)).emit("session:read_only", { read_only: next });

  // Enabling read-only revokes non-owner sending: cancel any in-flight transfer
  // whose sender is not the owner. Transfers the owner originated are kept.
  if (next && !wasReadOnly) {
    cancelTransfersWhere(
      io,
      session,
      ctx.owner.user_id,
      "read_only",
      (t) => t.from_user_id !== session.owner_user_id
    );
  }
}

// ---- owner: transfer ownership ---------------------------------------------

function handleOwnershipOffer(
  io: Server,
  socket: AppSocket,
  p: { to_user_id?: string }
): void {
  if (frozenBlocked(socket)) return;
  const ctx = getOwnerContext(socket);
  if (!ctx) {
    denyOwnerAction(socket);
    return;
  }
  if (!p.to_user_id) return;
  const target = ctx.session.members.get(p.to_user_id);
  if (!target || target.is_owner) {
    socket.emit("error", {
      code: "member_not_found",
      message: "no such member",
    });
    return;
  }
  // Record the offer so only this target can later accept it (and only before
  // it expires). Overwrites any prior outstanding offer from this owner.
  ctx.session.pending_owner_offer = {
    to_user_id: p.to_user_id,
    from_user_id: ctx.owner.user_id,
    created_at: Date.now(),
  };
  store.touch(ctx.session);
  emitTo(io, target, "owner_offered", { from_user_id: ctx.owner.user_id });
}

function handleOwnerAccept(io: Server, socket: AppSocket): void {
  if (frozenBlocked(socket)) return;
  const data = socket.data;
  if (!data || data.role !== "member" || !data.user_id) return;
  const session = store.getSession(data.slug);
  if (!session) return;
  const accepter = session.members.get(data.user_id);
  if (!accepter || accepter.is_owner) return;
  // Require a matching, non-expired offer addressed to this member. Without
  // this check any member could seize ownership by emitting `owner_accept`.
  const offer = session.pending_owner_offer;
  if (!offer || offer.to_user_id !== data.user_id) {
    socket.emit("error", {
      code: "no_pending_offer",
      message: "no ownership offer to accept",
    });
    return;
  }
  if (Date.now() - offer.created_at > config.ownerOfferTtlMs) {
    session.pending_owner_offer = null;
    socket.emit("error", {
      code: "offer_expired",
      message: "the ownership offer expired",
    });
    return;
  }
  if (store.transferOwnership(session, data.user_id)) {
    io.to(room(session.slug)).emit("owner:changed", {
      new_owner_user_id: data.user_id,
    });
    broadcastMembers(io, session);
  }
}

function handleOwnerDecline(io: Server, socket: AppSocket): void {
  if (frozenBlocked(socket)) return;
  const data = socket.data;
  if (!data || data.role !== "member" || !data.user_id) return;
  const session = store.getSession(data.slug);
  if (!session) return;
  // Only clear an offer that was actually addressed to the decliner.
  const offer = session.pending_owner_offer;
  if (offer && offer.to_user_id === data.user_id) {
    session.pending_owner_offer = null;
  }
  const owner = session.members.get(session.owner_user_id);
  emitTo(io, owner, "owner_declined", { by_user_id: data.user_id });
}

// ---- signaling state machine -----------------------------------------------

function senderContext(
  socket: AppSocket
): { session: Session; user_id: string } | null {
  const data = socket.data;
  if (!data || data.role !== "member" || !data.user_id) return null;
  const session = store.getSession(data.slug);
  if (!session) return null;
  if (!session.members.has(data.user_id)) return null;
  return { session, user_id: data.user_id };
}

function handleTransferRequest(
  io: Server,
  socket: AppSocket,
  p: { to_user_id?: string; files?: TransferFileMeta[]; client_ref?: string }
): void {
  if (frozenBlocked(socket)) return;
  const ctx = senderContext(socket);
  if (!ctx || !p.to_user_id) return;
  const { session, user_id } = ctx;
  // Opaque client correlation token, echoed back so the sender can map the
  // server-issued transfer_id to the exact pending send (robust to concurrent
  // sends to the same recipient). Bounded to avoid abuse.
  const clientRef =
    typeof p.client_ref === "string" && p.client_ref.length <= 64
      ? p.client_ref
      : undefined;

  if (p.to_user_id === user_id) {
    socket.emit("error", {
      code: "invalid_target",
      message: "cannot send to yourself",
    });
    return;
  }
  const recipient = session.members.get(p.to_user_id);
  if (!recipient || !recipient.socket_id) {
    socket.emit("error", {
      code: "recipient_unavailable",
      message: "recipient offline",
    });
    return;
  }
  // Moderation gates. The owner block bars sending to anyone; a recipient's
  // personal restrict bars this specific sender.
  if (session.blocked_user_ids.has(user_id)) {
    socket.emit("error", {
      code: "sender_blocked",
      message: "The owner has blocked you from sending files.",
    });
    return;
  }
  if (recipient.restricted_user_ids.has(user_id)) {
    socket.emit("error", {
      code: "sender_restricted",
      message: "This member isn't accepting files from you.",
    });
    return;
  }
  // Read-only sessions: only the owner may send files.
  if (session.read_only && user_id !== session.owner_user_id) {
    socket.emit("error", {
      code: "read_only",
      message: "Only the owner can send files in this session.",
    });
    return;
  }
  const files = Array.isArray(p.files) ? p.files : [];
  if (files.length === 0 || files.length > MAX_TRANSFER_FILES) {
    socket.emit("error", { code: "invalid_files", message: "bad file batch" });
    return;
  }
  if (!allowTransferRequest(user_id)) {
    socket.emit("error", {
      code: "rate_limited",
      message: "too many requests",
    });
    return;
  }

  const cleanFiles: TransferFileMeta[] = files.map((f) => ({
    name: String(f?.name ?? "file"),
    size: Number(f?.size ?? 0),
  }));
  const transfer = store.createTransfer(
    session,
    user_id,
    p.to_user_id,
    cleanFiles
  );
  logTransfer(session, transfer, "requested");

  // Ack the sender so it knows its server-issued transfer_id immediately.
  socket.emit("transfer:created", {
    transfer_id: transfer.transfer_id,
    to_user_id: p.to_user_id,
    client_ref: clientRef,
  });
  emitTo(io, recipient, "transfer:request", {
    transfer_id: transfer.transfer_id,
    from_user_id: user_id,
    files: cleanFiles,
  });
}

/** Resolve the transfer and verify the caller is the expected actor for `event`. */
function authorizeSignaling(
  socket: AppSocket,
  transfer_id: string | undefined,
  expect: { actor: "from" | "to" | "either"; states: TransferStateName[] }
): { session: Session; transfer: TransferState; user_id: string } | null {
  const ctx = senderContext(socket);
  if (!ctx || !transfer_id) return null;
  const transfer = ctx.session.transfers.get(transfer_id);
  if (!transfer) return null;
  if (!expect.states.includes(transfer.state)) {
    socket.emit("error", {
      code: "invalid_signaling_state",
      message: `bad state ${transfer.state}`,
    });
    return null;
  }
  const isFrom = transfer.from_user_id === ctx.user_id;
  const isTo = transfer.to_user_id === ctx.user_id;
  const ok =
    expect.actor === "either"
      ? isFrom || isTo
      : expect.actor === "from"
        ? isFrom
        : isTo;
  if (!ok) {
    socket.emit("error", {
      code: "invalid_signaling_state",
      message: "wrong actor",
    });
    return null;
  }
  return { session: ctx.session, transfer, user_id: ctx.user_id };
}

function otherPeer(transfer: TransferState, user_id: string): string {
  return transfer.from_user_id === user_id
    ? transfer.to_user_id
    : transfer.from_user_id;
}

function handleTransferResponse(
  io: Server,
  socket: AppSocket,
  p: { transfer_id?: string; accepted?: boolean; selected?: number[] }
): void {
  if (frozenBlocked(socket)) return;
  const r = authorizeSignaling(socket, p.transfer_id, {
    actor: "to",
    states: ["requested"],
  });
  if (!r) return;
  const { session, transfer } = r;
  const accepted = Boolean(p.accepted);
  // The receiver may accept a subset of the offered files. Sanitize the indices
  // against the offered file count: keep unique, in-range integers in order.
  let selected: number[] | undefined;
  if (accepted && Array.isArray(p.selected)) {
    const seen = new Set<number>();
    for (const i of p.selected) {
      if (Number.isInteger(i) && i >= 0 && i < transfer.files.length) {
        seen.add(i);
      }
    }
    selected = [...seen].sort((a, b) => a - b);
  }
  const from: TransferStateName = transfer.state;
  store.setTransferState(transfer, accepted ? "accepted" : "declined");
  // Narrow the server-side file record to the accepted subset for accurate
  // metadata/logging (does not affect the bytes, which flow peer-to-peer).
  if (accepted && selected && selected.length > 0) {
    transfer.files = selected.map((i) => transfer.files[i]);
  }
  logTransfer(session, transfer, from);
  emitTo(
    io,
    memberByUserId(session, transfer.from_user_id),
    "transfer:response",
    {
      transfer_id: transfer.transfer_id,
      to_user_id: transfer.to_user_id,
      accepted,
      ...(selected ? { selected } : {}),
    }
  );
  if (!accepted) recordTransferActivity(session, transfer, "declined");
}

function handleOffer(
  io: Server,
  socket: AppSocket,
  p: { transfer_id?: string; sdp?: unknown }
): void {
  if (frozenBlocked(socket)) return;
  const r = authorizeSignaling(socket, p.transfer_id, {
    actor: "from",
    states: ["accepted"],
  });
  if (!r) return;
  if (p.sdp === undefined || approxBytes(p.sdp) > MAX_SDP_BYTES) {
    socket.emit("error", {
      code: "invalid_payload",
      message: "missing or oversized sdp",
    });
    return;
  }
  const { session, transfer } = r;
  const from = transfer.state;
  store.setTransferState(transfer, "offering");
  logTransfer(session, transfer, from);
  emitTo(io, memberByUserId(session, transfer.to_user_id), "webrtc:offer", {
    transfer_id: transfer.transfer_id,
    sdp: p.sdp,
  });
}

function handleAnswer(
  io: Server,
  socket: AppSocket,
  p: { transfer_id?: string; sdp?: unknown }
): void {
  if (frozenBlocked(socket)) return;
  const r = authorizeSignaling(socket, p.transfer_id, {
    actor: "to",
    states: ["offering"],
  });
  if (!r) return;
  if (p.sdp === undefined || approxBytes(p.sdp) > MAX_SDP_BYTES) {
    socket.emit("error", {
      code: "invalid_payload",
      message: "missing or oversized sdp",
    });
    return;
  }
  const { session, transfer } = r;
  const from = transfer.state;
  store.setTransferState(transfer, "answered");
  logTransfer(session, transfer, from);
  emitTo(io, memberByUserId(session, transfer.from_user_id), "webrtc:answer", {
    transfer_id: transfer.transfer_id,
    sdp: p.sdp,
  });
}

function handleIce(
  io: Server,
  socket: AppSocket,
  p: { transfer_id?: string; candidate?: unknown }
): void {
  if (frozenBlocked(socket)) return;
  const r = authorizeSignaling(socket, p.transfer_id, {
    actor: "either",
    states: ["offering", "answered"],
  });
  if (!r) return;
  if (p.candidate === undefined || approxBytes(p.candidate) > MAX_ICE_BYTES) {
    socket.emit("error", {
      code: "invalid_payload",
      message: "missing or oversized candidate",
    });
    return;
  }
  const { session, transfer, user_id } = r;
  emitTo(
    io,
    memberByUserId(session, otherPeer(transfer, user_id)),
    "webrtc:ice",
    {
      transfer_id: transfer.transfer_id,
      candidate: p.candidate,
    }
  );
}

function handleTransferCancel(
  io: Server,
  socket: AppSocket,
  p: { transfer_id?: string; reason?: string }
): void {
  const r = authorizeSignaling(socket, p.transfer_id, {
    actor: "either",
    states: ["requested", "accepted", "offering", "answered"],
  });
  if (!r) return;
  const { session, transfer, user_id } = r;
  const from = transfer.state;
  store.setTransferState(transfer, "cancelled");
  logTransfer(session, transfer, from);
  emitTo(
    io,
    memberByUserId(session, otherPeer(transfer, user_id)),
    "transfer:cancelled",
    {
      transfer_id: transfer.transfer_id,
      by_user_id: user_id,
      reason: p.reason ?? "cancelled",
    }
  );
  recordTransferActivity(session, transfer, "cancelled");
}

function handleTransferComplete(
  io: Server,
  socket: AppSocket,
  p: { transfer_id?: string }
): void {
  if (frozenBlocked(socket)) return;
  const r = authorizeSignaling(socket, p.transfer_id, {
    actor: "either",
    states: ["answered"],
  });
  if (!r) return;
  const { session, transfer, user_id } = r;
  const from = transfer.state;
  store.setTransferState(transfer, "closed");
  logTransfer(session, transfer, from);
  emitTo(
    io,
    memberByUserId(session, otherPeer(transfer, user_id)),
    "transfer:closed",
    {
      transfer_id: transfer.transfer_id,
    }
  );
  recordTransferActivity(session, transfer, "complete");
}

// ---- leave / disconnect ----------------------------------------------------

function cancelPeerTransfers(
  io: Server,
  session: Session,
  user_id: string
): void {
  const cancelled = store.cancelTransfersForUser(session, user_id);
  for (const { transfer, other_user_id } of cancelled) {
    emitTo(io, memberByUserId(session, other_user_id), "transfer:cancelled", {
      transfer_id: transfer.transfer_id,
      by_user_id: user_id,
      reason: "peer_left",
    });
  }
}

function handleLeave(io: Server, socket: AppSocket, ack?: () => void): void {
  const data = socket.data;
  if (!data || data.role !== "member" || !data.user_id) {
    ack?.();
    return;
  }
  const session = store.getSession(data.slug);
  if (!session) {
    ack?.();
    return;
  }

  if (data.user_id === session.owner_user_id) {
    store.endSession(session.slug, "owner_left"); // emits session:ended -> disconnects room
    ack?.();
    return;
  }
  cancelPeerTransfers(io, session, data.user_id);
  const leaverName =
    session.members.get(data.user_id)?.display_name ?? "Member";
  // Keep the leaver's uploaded files in the bucket (orphaned); the owner can
  // remove them later. Their token is still revoked so access ends immediately.
  store.removeMember(session, data.user_id, false);
  forgetTransferRate(data.user_id);
  io.to(room(session.slug)).emit("member:left", { user_id: data.user_id });
  broadcastMembers(io, session);
  const leaveEntry = store.recordActivity(session, {
    type: "leave",
    actor_user_id: data.user_id,
    actor_name: leaverName,
  });
  emitActivity(session, leaveEntry);
  // A departing member is pruned from the reports queue (as target/reporter).
  emitReports(io, session);
  socket.leave(room(session.slug));
  ack?.();
}

function handleDisconnect(io: Server, socket: AppSocket): void {
  const data = socket.data;
  if (!data) return;

  if (data.role === "pending" && data.knock_id) {
    const session = store.getSession(data.slug);
    const knocker = session?.knockers.get(data.knock_id);
    // Tolerate refresh: only unbind the socket; TTL handles stale knocks.
    if (knocker && knocker.socket_id === socket.id) knocker.socket_id = null;
    return;
  }

  if (data.role === "member" && data.user_id) {
    const session = store.getSession(data.slug);
    if (!session) return;
    const member = session.members.get(data.user_id);
    if (!member || member.socket_id !== socket.id) return; // superseded by a newer socket

    member.socket_id = null;
    if (member.is_owner) session.owner_disconnected_at = Date.now();

    member.offline_grace_timer = setTimeout(() => {
      member.offline_grace_timer = null;
      if (member.socket_id !== null) return; // reconnected during grace
      io.to(room(session.slug)).emit("member:offline", {
        user_id: member.user_id,
      });
      broadcastMembers(io, session);
      cancelPeerTransfers(io, session, member.user_id);

      // The owner is the trust anchor: once they're confirmed offline, surface
      // the real grace deadline to the room and arm a precise teardown so the
      // session ends exactly when the countdown does (the sweeper stays as a
      // backstop). Both the emitted deadline and the timer are anchored to
      // owner_disconnected_at so the displayed countdown matches the teardown.
      if (member.is_owner && session.owner_disconnected_at !== null) {
        const grace_ms = Math.max(
          0,
          session.owner_disconnected_at + config.ownerGraceMs - Date.now()
        );
        io.to(room(session.slug)).emit("owner:offline", { grace_ms });
        if (session.owner_grace_timer) clearTimeout(session.owner_grace_timer);
        session.owner_grace_timer = setTimeout(() => {
          session.owner_grace_timer = null;
          if (member.socket_id !== null) return; // reconnected during grace
          store.endSession(session.slug, "owner_left");
        }, grace_ms);
      }
    }, config.presenceGraceMs);
  }
}
