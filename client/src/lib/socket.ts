import { io, type Socket } from 'socket.io-client';
import type { PublicMember, PublicBucketEntry } from './api';

export interface TransferFileMeta {
  name: string;
  size: number;
}

export interface ServerToClient {
  'state:snapshot': (p: {
    slug: string;
    your_user_id: string;
    owner_user_id: string;
    knocking_paused: boolean;
    frozen: boolean;
    members: PublicMember[];
    bucket: PublicBucketEntry[];
  }) => void;
  'members:list': (p: { members: PublicMember[] }) => void;
  'member:joined': (p: { member: PublicMember }) => void;
  'member:left': (p: { user_id: string }) => void;
  'member:online': (p: { user_id: string }) => void;
  'member:offline': (p: { user_id: string }) => void;
  'knock:new': (p: { knock_id: string; display_name: string; created_at: number }) => void;
  'knock:cancelled': (p: { knock_id: string }) => void;
  'knock:expired': (p: { knock_id: string }) => void;
  'invite:used': (p: { code: string; user_id: string; display_name: string }) => void;
  'knocking:paused': (p: { paused: boolean }) => void;
  'session:frozen': (p: { frozen: boolean }) => void;
  waiting: (p: { knock_id: string }) => void;
  admitted: (p: {
    user_id: string;
    owner_user_id: string;
    members: PublicMember[];
    bucket: PublicBucketEntry[];
  }) => void;
  rejected: (p: Record<string, never>) => void;
  kicked: (p: { reason: string }) => void;
  'owner:changed': (p: { new_owner_user_id: string }) => void;
  owner_offered: (p: { from_user_id: string }) => void;
  owner_declined: (p: { by_user_id: string }) => void;
  'owner_offer:expired': (p: { to_user_id: string }) => void;
  'file:added': (p: { entry: PublicBucketEntry }) => void;
  'file:removed': (p: { id: string }) => void;
  'transfer:created': (p: { transfer_id: string; to_user_id: string; client_ref?: string }) => void;
  'transfer:request': (p: { transfer_id: string; from_user_id: string; files: TransferFileMeta[] }) => void;
  'transfer:response': (p: { transfer_id: string; to_user_id: string; accepted: boolean }) => void;
  'transfer:cancelled': (p: { transfer_id: string; by_user_id: string; reason: string }) => void;
  'transfer:expired': (p: { transfer_id: string }) => void;
  'transfer:closed': (p: { transfer_id: string }) => void;
  'webrtc:offer': (p: { transfer_id: string; sdp: RTCSessionDescriptionInit }) => void;
  'webrtc:answer': (p: { transfer_id: string; sdp: RTCSessionDescriptionInit }) => void;
  'webrtc:ice': (p: { transfer_id: string; candidate: RTCIceCandidateInit }) => void;
  'session:ended': (p: { reason: string }) => void;
  error: (p: { code: string; message: string }) => void;
}

export interface ClientToServer {
  identify: (p: { slug: string; tab_id: string }) => void;
  admit: (p: { knock_id: string }) => void;
  reject: (p: { knock_id: string }) => void;
  kick: (p: { user_id: string }) => void;
  'knocking:set_paused': (p: { paused: boolean }) => void;
  'session:set_frozen': (p: { frozen: boolean }) => void;
  transfer_ownership: (p: { to_user_id: string }) => void;
  owner_accept: () => void;
  owner_decline: () => void;
  'transfer:request': (p: { to_user_id: string; files: TransferFileMeta[]; client_ref?: string }) => void;
  'transfer:response': (p: { transfer_id: string; accepted: boolean }) => void;
  'transfer:cancel': (p: { transfer_id: string; reason?: string }) => void;
  'transfer:complete': (p: { transfer_id: string }) => void;
  'webrtc:offer': (p: { transfer_id: string; sdp: RTCSessionDescriptionInit }) => void;
  'webrtc:answer': (p: { transfer_id: string; sdp: RTCSessionDescriptionInit }) => void;
  'webrtc:ice': (p: { transfer_id: string; candidate: RTCIceCandidateInit }) => void;
  leave: (ack: () => void) => void;
}

export type AppSocket = Socket<ServerToClient, ClientToServer>;

export function createSocket(): AppSocket {
  return io({
    path: '/api/ws',
    withCredentials: true,
    autoConnect: true,
    reconnection: true,
  });
}
