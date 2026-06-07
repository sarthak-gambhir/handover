import type { Server } from 'socket.io';
import type { Session } from './types.js';

let io: Server | null = null;

export function setIo(server: Server): void {
  io = server;
}

export function getIo(): Server | null {
  return io;
}

export function room(slug: string): string {
  return `session:${slug}`;
}

export function emitToSession(slug: string, event: string, payload: unknown): void {
  io?.to(room(slug)).emit(event, payload);
}

export function emitToSocket(socketId: string | null, event: string, payload: unknown): void {
  if (socketId) io?.to(socketId).emit(event, payload);
}

/** Emit to the owner's currently-bound socket, if online. */
export function emitToOwner(session: Session, event: string, payload: unknown): void {
  const owner = session.members.get(session.owner_user_id);
  if (owner?.socket_id) emitToSocket(owner.socket_id, event, payload);
}

/** Emit to a member by user_id, if online. */
export function emitToUser(session: Session, user_id: string, event: string, payload: unknown): void {
  const member = session.members.get(user_id);
  if (member?.socket_id) emitToSocket(member.socket_id, event, payload);
}

export function disconnectSocket(socketId: string | null): void {
  if (socketId && io) io.sockets.sockets.get(socketId)?.disconnect(true);
}
