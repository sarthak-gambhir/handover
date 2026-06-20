import type { Server } from "socket.io";
import type { Session, ActivityEntry } from "./types.js";
import { canSeeActivity } from "./sessions.js";

let io: Server | null = null;

export function setIo(server: Server): void {
  io = server;
}

export function room(slug: string): string {
  return `session:${slug}`;
}

export function emitToSession(
  slug: string,
  event: string,
  payload: unknown
): void {
  io?.to(room(slug)).emit(event, payload);
}

export function emitToSocket(
  socketId: string | null,
  event: string,
  payload: unknown
): void {
  if (socketId) io?.to(socketId).emit(event, payload);
}

/** Emit to the owner's currently-bound socket, if online. */
export function emitToOwner(
  session: Session,
  event: string,
  payload: unknown
): void {
  const owner = session.members.get(session.owner_user_id);
  if (owner?.socket_id) emitToSocket(owner.socket_id, event, payload);
}

/**
 * Broadcast a new activity entry to exactly the members allowed to see it: the
 * owner always, plus any member for whom `canSeeActivity` holds (actor/target,
 * or everyone for public entries). Offline members pick it up via the snapshot.
 */
export function emitActivity(session: Session, entry: ActivityEntry): void {
  for (const member of session.members.values()) {
    if (!member.socket_id) continue;
    if (!canSeeActivity(entry, member.user_id, session.owner_user_id)) continue;
    emitToSocket(member.socket_id, "activity:new", { entry });
  }
}
