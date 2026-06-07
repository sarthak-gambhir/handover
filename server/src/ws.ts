import type { Server, Socket, DefaultEventsMap } from 'socket.io';
import { parse as parseCookie } from 'cookie';
import { store } from './sessions.js';
import { normalizeSlug } from './slug.js';
import { config } from './config.js';
import { room } from './realtime.js';
import { cookieName } from './auth.js';
import {
  type Session,
  type Member,
  type TransferState,
  type TransferStateName,
  type TransferFileMeta,
} from './types.js';

interface SocketData {
  slug: string;
  role: 'member' | 'pending';
  user_id?: string; // when member
  knock_id?: string; // when pending
  tab_id?: string;
}

type AppSocket = Socket<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketData>;

const MAX_TRANSFER_FILES = 32;

// Per-event payload size limits (defence in depth on top of maxHttpBufferSize).
const MAX_SDP_BYTES = 64 * 1024;
const MAX_ICE_BYTES = 8 * 1024;

/** Rough serialized size of a signaling payload value. */
function approxBytes(v: unknown): number {
  if (typeof v === 'string') return v.length;
  try {
    return JSON.stringify(v).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function denyOwnerAction(socket: AppSocket): void {
  socket.emit('error', { code: 'owner_only', message: 'owner action not permitted' });
}

// transfer:request rate limit — 20/min/sender (sliding window).
const requestTimestamps = new Map<string, number[]>();
function allowTransferRequest(user_id: string): boolean {
  const now = Date.now();
  const arr = (requestTimestamps.get(user_id) ?? []).filter((t) => now - t < 60_000);
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

function logTransfer(session: Session, transfer: TransferState, from: TransferStateName): void {
  const log = transfer.state_log;
  const prev = log.length >= 2 ? log[log.length - 2].at : transfer.created_at;
  const ms = Date.now() - prev;
  console.log(
    `[transfer] ${session.slug} ${transfer.transfer_id} ${from}->${transfer.state} (+${ms}ms)`,
  );
}

function memberByUserId(session: Session, user_id: string): Member | undefined {
  return session.members.get(user_id);
}

function emitTo(io: Server, member: Member | undefined, event: string, payload: unknown): void {
  if (member?.socket_id) io.to(member.socket_id).emit(event, payload);
}

function broadcastMembers(io: Server, session: Session): void {
  io.to(room(session.slug)).emit('members:list', { members: store.publicMembers(session) });
}

export function registerWs(io: Server): void {
  // Evict stale transfer rate-limit buckets so the map can't leak as users
  // come and go (including those removed by session/idle timeouts).
  const ratePrune = setInterval(() => pruneTransferRates(), 5 * 60_000);
  if (typeof ratePrune.unref === 'function') ratePrune.unref();

  // Sweeper-driven broadcasts.
  store.on('knock:expired', ({ slug, knock_id, socket_id }) => {
    const session = store.getSession(slug);
    if (session) {
      const owner = session.members.get(session.owner_user_id);
      emitTo(io, owner, 'knock:expired', { knock_id });
    }
    if (socket_id) io.to(socket_id).emit('knock:expired', { knock_id });
  });

  store.on('session:ended', ({ slug, reason }) => {
    io.to(room(slug)).emit('session:ended', { reason });
    // Disconnect everyone in the room.
    io.in(room(slug)).disconnectSockets(true);
  });

  store.on('transfer:expired', ({ slug, transfer }) => {
    const session = store.getSession(slug);
    if (!session) return;
    const payload = { transfer_id: transfer.transfer_id };
    emitTo(io, memberByUserId(session, transfer.from_user_id), 'transfer:expired', payload);
    emitTo(io, memberByUserId(session, transfer.to_user_id), 'transfer:expired', payload);
  });

  store.on('owner_offer:expired', ({ slug, to_user_id, from_user_id }) => {
    const session = store.getSession(slug);
    if (!session) return;
    emitTo(io, memberByUserId(session, from_user_id), 'owner_offer:expired', { to_user_id });
    emitTo(io, memberByUserId(session, to_user_id), 'owner_offer:expired', { to_user_id });
  });

  io.on('connection', (socket: AppSocket) => {
    socket.on('identify', (payload: { slug?: string; tab_id?: string }) => {
      handleIdentify(io, socket, payload);
    });

    // ---- owner-only events ----
    socket.on('admit', (p: { knock_id?: string }) => handleAdmit(io, socket, p));
    socket.on('reject', (p: { knock_id?: string }) => handleReject(io, socket, p));
    socket.on('kick', (p: { user_id?: string }) => handleKick(io, socket, p));
    socket.on('knocking:set_paused', (p: { paused?: boolean }) => handlePause(io, socket, p));
    socket.on('transfer_ownership', (p: { to_user_id?: string }) =>
      handleOwnershipOffer(io, socket, p),
    );
    socket.on('owner_accept', () => handleOwnerAccept(io, socket));
    socket.on('owner_decline', () => handleOwnerDecline(io, socket));

    // ---- signaling ----
    socket.on('transfer:request', (p: { to_user_id?: string; files?: TransferFileMeta[] }) =>
      handleTransferRequest(io, socket, p),
    );
    socket.on('transfer:response', (p: { transfer_id?: string; accepted?: boolean }) =>
      handleTransferResponse(io, socket, p),
    );
    socket.on('webrtc:offer', (p: { transfer_id?: string; sdp?: unknown }) =>
      handleOffer(io, socket, p),
    );
    socket.on('webrtc:answer', (p: { transfer_id?: string; sdp?: unknown }) =>
      handleAnswer(io, socket, p),
    );
    socket.on('webrtc:ice', (p: { transfer_id?: string; candidate?: unknown }) =>
      handleIce(io, socket, p),
    );
    socket.on('transfer:cancel', (p: { transfer_id?: string; reason?: string }) =>
      handleTransferCancel(io, socket, p),
    );
    socket.on('transfer:complete', (p: { transfer_id?: string }) =>
      handleTransferComplete(io, socket, p),
    );

    socket.on('leave', (ack?: () => void) => handleLeave(io, socket, ack));
    socket.on('disconnect', () => handleDisconnect(io, socket));
  });
}

// ---- identify --------------------------------------------------------------

function resolveCookieToken(socket: AppSocket, slug: string): string | undefined {
  const raw = socket.handshake.headers.cookie;
  if (!raw) return undefined;
  const cookies = parseCookie(raw);
  return cookies[cookieName(slug)];
}

function handleIdentify(
  io: Server,
  socket: AppSocket,
  payload: { slug?: string; tab_id?: string },
): void {
  const slug = normalizeSlug(payload.slug ?? '');
  const tab_id = payload.tab_id;
  if (!slug || !tab_id) {
    socket.emit('error', { code: 'bad_identify', message: 'slug and tab_id required' });
    return;
  }
  const session = store.getSession(slug);
  if (!session) {
    socket.emit('error', { code: 'session_not_found', message: 'no such session' });
    return;
  }
  const token = resolveCookieToken(socket, slug);
  const entry = store.lookupToken(token);
  if (!entry || entry.slug !== slug) {
    socket.emit('error', { code: 'unauthorized', message: 'no valid session cookie' });
    return;
  }

  if (entry.status === 'pending') {
    // Waiting-screen socket: bind so admit/reject/expire can route here.
    const knocker = session.knockers.get(entry.knock_id);
    if (!knocker) {
      socket.emit('error', { code: 'unauthorized', message: 'knock no longer pending' });
      return;
    }
    knocker.socket_id = socket.id;
    socket.data = { slug, role: 'pending', knock_id: entry.knock_id, tab_id };
    socket.emit('waiting', { knock_id: entry.knock_id });
    return;
  }

  // Member identify.
  const member = session.members.get(entry.user_id);
  if (!member) {
    socket.emit('error', { code: 'unauthorized', message: 'member not found' });
    return;
  }

  // One-tab enforcement.
  if (member.socket_id && member.tab_id && member.tab_id !== tab_id) {
    const existing = io.sockets.sockets.get(member.socket_id);
    if (existing && existing.connected) {
      socket.emit('error', {
        code: 'already_open_elsewhere',
        message: 'This session is already open in another tab.',
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
  if (member.is_owner) session.owner_disconnected_at = null;

  socket.data = { slug, role: 'member', user_id: member.user_id, tab_id };
  socket.join(room(slug));
  store.touch(session);

  socket.emit('state:snapshot', {
    slug: session.slug,
    your_user_id: member.user_id,
    owner_user_id: session.owner_user_id,
    knocking_paused: session.knocking_paused,
    members: store.publicMembers(session),
    bucket: store.publicBucket(session),
  });
  io.to(room(slug)).emit('member:online', { user_id: member.user_id });
  broadcastMembers(io, session);
}

// ---- owner: admit / reject -------------------------------------------------

function getOwnerContext(
  socket: AppSocket,
): { session: Session; owner: Member } | null {
  const data = socket.data;
  if (!data || data.role !== 'member' || !data.user_id) return null;
  const session = store.getSession(data.slug);
  if (!session) return null;
  const owner = session.members.get(data.user_id);
  if (!owner || !owner.is_owner) return null;
  return { session, owner };
}

function handleAdmit(io: Server, socket: AppSocket, p: { knock_id?: string }): void {
  const ctx = getOwnerContext(socket);
  if (!ctx) {
    denyOwnerAction(socket);
    return;
  }
  if (!p.knock_id) return;
  const { session } = ctx;
  const knocker = session.knockers.get(p.knock_id);
  if (!knocker) {
    socket.emit('error', { code: 'knock_not_found', message: 'no such knock' });
    return;
  }
  const waitingSocketId = knocker.socket_id;

  const member = store.admitKnocker(session, p.knock_id);
  if (!member) return;

  if (waitingSocketId) {
    io.to(waitingSocketId).emit('admitted', {
      user_id: member.user_id,
      owner_user_id: session.owner_user_id,
      members: store.publicMembers(session),
      bucket: store.publicBucket(session),
    });
  }
  io.to(room(session.slug)).emit('member:joined', { member: store.publicMember(member) });
  broadcastMembers(io, session);
  // Clear the resolved knock from the owner's queue.
  emitTo(io, ctx.owner, 'knock:cancelled', { knock_id: p.knock_id });
}

function handleReject(io: Server, socket: AppSocket, p: { knock_id?: string }): void {
  const ctx = getOwnerContext(socket);
  if (!ctx) {
    denyOwnerAction(socket);
    return;
  }
  if (!p.knock_id) return;
  const knocker = store.removeKnocker(ctx.session, p.knock_id);
  if (knocker?.socket_id) io.to(knocker.socket_id).emit('rejected', {});
  // Clear the resolved knock from the owner's queue.
  emitTo(io, ctx.owner, 'knock:cancelled', { knock_id: p.knock_id });
}

// ---- owner: kick -----------------------------------------------------------

function handleKick(io: Server, socket: AppSocket, p: { user_id?: string }): void {
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
    socket.emit('error', { code: 'member_not_found', message: 'no such member' });
    return;
  }

  const targetSocketId = target.socket_id;

  // Collect this member's bucket file ids before removal.
  const fileIds = [...session.bucket.values()]
    .filter((e) => e.uploader_id === p.user_id)
    .map((e) => e.id);

  // Cancel in-flight transfers, notify the other peers.
  const cancelled = store.cancelTransfersForUser(session, p.user_id);

  // Remove the member (also purges token + deletes their bucket files).
  store.removeMember(session, p.user_id);
  forgetTransferRate(p.user_id);

  for (const id of fileIds) io.to(room(session.slug)).emit('file:removed', { id });
  for (const { transfer, other_user_id } of cancelled) {
    emitTo(io, memberByUserId(session, other_user_id), 'transfer:cancelled', {
      transfer_id: transfer.transfer_id,
      by_user_id: p.user_id,
      reason: 'peer_left',
    });
  }

  if (targetSocketId) {
    io.to(targetSocketId).emit('kicked', { reason: 'removed_by_owner' });
    io.sockets.sockets.get(targetSocketId)?.disconnect(true);
  }
  broadcastMembers(io, session);
}

// ---- owner: pause knocking -------------------------------------------------

function handlePause(io: Server, socket: AppSocket, p: { paused?: boolean }): void {
  const ctx = getOwnerContext(socket);
  if (!ctx) {
    denyOwnerAction(socket);
    return;
  }
  ctx.session.knocking_paused = Boolean(p.paused);
  // Broadcast to the whole room so every client reflects the pause state, not
  // just the owner's own tab.
  io.to(room(ctx.session.slug)).emit('knocking:paused', { paused: ctx.session.knocking_paused });
}

// ---- owner: transfer ownership ---------------------------------------------

function handleOwnershipOffer(io: Server, socket: AppSocket, p: { to_user_id?: string }): void {
  const ctx = getOwnerContext(socket);
  if (!ctx) {
    denyOwnerAction(socket);
    return;
  }
  if (!p.to_user_id) return;
  const target = ctx.session.members.get(p.to_user_id);
  if (!target || target.is_owner) {
    socket.emit('error', { code: 'member_not_found', message: 'no such member' });
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
  emitTo(io, target, 'owner_offered', { from_user_id: ctx.owner.user_id });
}

function handleOwnerAccept(io: Server, socket: AppSocket): void {
  const data = socket.data;
  if (!data || data.role !== 'member' || !data.user_id) return;
  const session = store.getSession(data.slug);
  if (!session) return;
  const accepter = session.members.get(data.user_id);
  if (!accepter || accepter.is_owner) return;
  // Require a matching, non-expired offer addressed to this member. Without
  // this check any member could seize ownership by emitting `owner_accept`.
  const offer = session.pending_owner_offer;
  if (!offer || offer.to_user_id !== data.user_id) {
    socket.emit('error', { code: 'no_pending_offer', message: 'no ownership offer to accept' });
    return;
  }
  if (Date.now() - offer.created_at > config.ownerOfferTtlMs) {
    session.pending_owner_offer = null;
    socket.emit('error', { code: 'offer_expired', message: 'the ownership offer expired' });
    return;
  }
  if (store.transferOwnership(session, data.user_id)) {
    io.to(room(session.slug)).emit('owner:changed', { new_owner_user_id: data.user_id });
    broadcastMembers(io, session);
  }
}

function handleOwnerDecline(io: Server, socket: AppSocket): void {
  const data = socket.data;
  if (!data || data.role !== 'member' || !data.user_id) return;
  const session = store.getSession(data.slug);
  if (!session) return;
  // Only clear an offer that was actually addressed to the decliner.
  const offer = session.pending_owner_offer;
  if (offer && offer.to_user_id === data.user_id) {
    session.pending_owner_offer = null;
  }
  const owner = session.members.get(session.owner_user_id);
  emitTo(io, owner, 'owner_declined', { by_user_id: data.user_id });
}

// ---- signaling state machine -----------------------------------------------

function senderContext(
  socket: AppSocket,
): { session: Session; user_id: string } | null {
  const data = socket.data;
  if (!data || data.role !== 'member' || !data.user_id) return null;
  const session = store.getSession(data.slug);
  if (!session) return null;
  if (!session.members.has(data.user_id)) return null;
  return { session, user_id: data.user_id };
}

function handleTransferRequest(
  io: Server,
  socket: AppSocket,
  p: { to_user_id?: string; files?: TransferFileMeta[]; client_ref?: string },
): void {
  const ctx = senderContext(socket);
  if (!ctx || !p.to_user_id) return;
  const { session, user_id } = ctx;
  // Opaque client correlation token, echoed back so the sender can map the
  // server-issued transfer_id to the exact pending send (robust to concurrent
  // sends to the same recipient). Bounded to avoid abuse.
  const clientRef =
    typeof p.client_ref === 'string' && p.client_ref.length <= 64 ? p.client_ref : undefined;

  if (p.to_user_id === user_id) {
    socket.emit('error', { code: 'invalid_target', message: 'cannot send to yourself' });
    return;
  }
  const recipient = session.members.get(p.to_user_id);
  if (!recipient || !recipient.socket_id) {
    socket.emit('error', { code: 'recipient_unavailable', message: 'recipient offline' });
    return;
  }
  const files = Array.isArray(p.files) ? p.files : [];
  if (files.length === 0 || files.length > MAX_TRANSFER_FILES) {
    socket.emit('error', { code: 'invalid_files', message: 'bad file batch' });
    return;
  }
  if (!allowTransferRequest(user_id)) {
    socket.emit('error', { code: 'rate_limited', message: 'too many requests' });
    return;
  }

  const cleanFiles: TransferFileMeta[] = files.map((f) => ({
    name: String(f?.name ?? 'file'),
    size: Number(f?.size ?? 0),
  }));
  const transfer = store.createTransfer(session, user_id, p.to_user_id, cleanFiles);
  logTransfer(session, transfer, 'requested');

  // Ack the sender so it knows its server-issued transfer_id immediately.
  socket.emit('transfer:created', {
    transfer_id: transfer.transfer_id,
    to_user_id: p.to_user_id,
    client_ref: clientRef,
  });
  emitTo(io, recipient, 'transfer:request', {
    transfer_id: transfer.transfer_id,
    from_user_id: user_id,
    files: cleanFiles,
  });
}

/** Resolve the transfer and verify the caller is the expected actor for `event`. */
function authorizeSignaling(
  socket: AppSocket,
  transfer_id: string | undefined,
  expect: { actor: 'from' | 'to' | 'either'; states: TransferStateName[] },
): { session: Session; transfer: TransferState; user_id: string } | null {
  const ctx = senderContext(socket);
  if (!ctx || !transfer_id) return null;
  const transfer = ctx.session.transfers.get(transfer_id);
  if (!transfer) return null;
  if (!expect.states.includes(transfer.state)) {
    socket.emit('error', { code: 'invalid_signaling_state', message: `bad state ${transfer.state}` });
    return null;
  }
  const isFrom = transfer.from_user_id === ctx.user_id;
  const isTo = transfer.to_user_id === ctx.user_id;
  const ok =
    expect.actor === 'either'
      ? isFrom || isTo
      : expect.actor === 'from'
        ? isFrom
        : isTo;
  if (!ok) {
    socket.emit('error', { code: 'invalid_signaling_state', message: 'wrong actor' });
    return null;
  }
  return { session: ctx.session, transfer, user_id: ctx.user_id };
}

function otherPeer(transfer: TransferState, user_id: string): string {
  return transfer.from_user_id === user_id ? transfer.to_user_id : transfer.from_user_id;
}

function handleTransferResponse(
  io: Server,
  socket: AppSocket,
  p: { transfer_id?: string; accepted?: boolean },
): void {
  const r = authorizeSignaling(socket, p.transfer_id, { actor: 'to', states: ['requested'] });
  if (!r) return;
  const { session, transfer } = r;
  const accepted = Boolean(p.accepted);
  const from: TransferStateName = transfer.state;
  store.setTransferState(transfer, accepted ? 'accepted' : 'declined');
  logTransfer(session, transfer, from);
  emitTo(io, memberByUserId(session, transfer.from_user_id), 'transfer:response', {
    transfer_id: transfer.transfer_id,
    to_user_id: transfer.to_user_id,
    accepted,
  });
}

function handleOffer(io: Server, socket: AppSocket, p: { transfer_id?: string; sdp?: unknown }): void {
  const r = authorizeSignaling(socket, p.transfer_id, { actor: 'from', states: ['accepted'] });
  if (!r) return;
  if (p.sdp === undefined || approxBytes(p.sdp) > MAX_SDP_BYTES) {
    socket.emit('error', { code: 'invalid_payload', message: 'missing or oversized sdp' });
    return;
  }
  const { session, transfer } = r;
  const from = transfer.state;
  store.setTransferState(transfer, 'offering');
  logTransfer(session, transfer, from);
  emitTo(io, memberByUserId(session, transfer.to_user_id), 'webrtc:offer', {
    transfer_id: transfer.transfer_id,
    sdp: p.sdp,
  });
}

function handleAnswer(io: Server, socket: AppSocket, p: { transfer_id?: string; sdp?: unknown }): void {
  const r = authorizeSignaling(socket, p.transfer_id, { actor: 'to', states: ['offering'] });
  if (!r) return;
  if (p.sdp === undefined || approxBytes(p.sdp) > MAX_SDP_BYTES) {
    socket.emit('error', { code: 'invalid_payload', message: 'missing or oversized sdp' });
    return;
  }
  const { session, transfer } = r;
  const from = transfer.state;
  store.setTransferState(transfer, 'answered');
  logTransfer(session, transfer, from);
  emitTo(io, memberByUserId(session, transfer.from_user_id), 'webrtc:answer', {
    transfer_id: transfer.transfer_id,
    sdp: p.sdp,
  });
}

function handleIce(
  io: Server,
  socket: AppSocket,
  p: { transfer_id?: string; candidate?: unknown },
): void {
  const r = authorizeSignaling(socket, p.transfer_id, {
    actor: 'either',
    states: ['offering', 'answered'],
  });
  if (!r) return;
  if (p.candidate === undefined || approxBytes(p.candidate) > MAX_ICE_BYTES) {
    socket.emit('error', { code: 'invalid_payload', message: 'missing or oversized candidate' });
    return;
  }
  const { session, transfer, user_id } = r;
  emitTo(io, memberByUserId(session, otherPeer(transfer, user_id)), 'webrtc:ice', {
    transfer_id: transfer.transfer_id,
    candidate: p.candidate,
  });
}

function handleTransferCancel(
  io: Server,
  socket: AppSocket,
  p: { transfer_id?: string; reason?: string },
): void {
  const r = authorizeSignaling(socket, p.transfer_id, {
    actor: 'either',
    states: ['requested', 'accepted', 'offering', 'answered'],
  });
  if (!r) return;
  const { session, transfer, user_id } = r;
  const from = transfer.state;
  store.setTransferState(transfer, 'cancelled');
  logTransfer(session, transfer, from);
  emitTo(io, memberByUserId(session, otherPeer(transfer, user_id)), 'transfer:cancelled', {
    transfer_id: transfer.transfer_id,
    by_user_id: user_id,
    reason: p.reason ?? 'cancelled',
  });
}

function handleTransferComplete(
  io: Server,
  socket: AppSocket,
  p: { transfer_id?: string },
): void {
  const r = authorizeSignaling(socket, p.transfer_id, { actor: 'either', states: ['answered'] });
  if (!r) return;
  const { session, transfer, user_id } = r;
  const from = transfer.state;
  store.setTransferState(transfer, 'closed');
  logTransfer(session, transfer, from);
  emitTo(io, memberByUserId(session, otherPeer(transfer, user_id)), 'transfer:closed', {
    transfer_id: transfer.transfer_id,
  });
}

// ---- leave / disconnect ----------------------------------------------------

function cancelPeerTransfers(io: Server, session: Session, user_id: string): void {
  const cancelled = store.cancelTransfersForUser(session, user_id);
  for (const { transfer, other_user_id } of cancelled) {
    emitTo(io, memberByUserId(session, other_user_id), 'transfer:cancelled', {
      transfer_id: transfer.transfer_id,
      by_user_id: user_id,
      reason: 'peer_left',
    });
  }
}

function handleLeave(io: Server, socket: AppSocket, ack?: () => void): void {
  const data = socket.data;
  if (!data || data.role !== 'member' || !data.user_id) {
    ack?.();
    return;
  }
  const session = store.getSession(data.slug);
  if (!session) {
    ack?.();
    return;
  }

  if (data.user_id === session.owner_user_id) {
    store.endSession(session.slug, 'owner_left'); // emits session:ended -> disconnects room
    ack?.();
    return;
  }
  cancelPeerTransfers(io, session, data.user_id);
  // Keep the leaver's uploaded files in the bucket (orphaned); the owner can
  // remove them later. Their token is still revoked so access ends immediately.
  store.removeMember(session, data.user_id, false);
  forgetTransferRate(data.user_id);
  io.to(room(session.slug)).emit('member:left', { user_id: data.user_id });
  broadcastMembers(io, session);
  socket.leave(room(session.slug));
  ack?.();
}

function handleDisconnect(io: Server, socket: AppSocket): void {
  const data = socket.data;
  if (!data) return;

  if (data.role === 'pending' && data.knock_id) {
    const session = store.getSession(data.slug);
    const knocker = session?.knockers.get(data.knock_id);
    // Tolerate refresh: only unbind the socket; TTL handles stale knocks.
    if (knocker && knocker.socket_id === socket.id) knocker.socket_id = null;
    return;
  }

  if (data.role === 'member' && data.user_id) {
    const session = store.getSession(data.slug);
    if (!session) return;
    const member = session.members.get(data.user_id);
    if (!member || member.socket_id !== socket.id) return; // superseded by a newer socket

    member.socket_id = null;
    if (member.is_owner) session.owner_disconnected_at = Date.now();

    member.offline_grace_timer = setTimeout(() => {
      member.offline_grace_timer = null;
      if (member.socket_id !== null) return; // reconnected during grace
      io.to(room(session.slug)).emit('member:offline', { user_id: member.user_id });
      broadcastMembers(io, session);
      cancelPeerTransfers(io, session, member.user_id);
    }, config.presenceGraceMs);
  }
}
