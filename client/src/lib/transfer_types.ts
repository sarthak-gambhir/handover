import type { TransferFileMeta } from './socket';

export type TransferStatus =
  | 'requesting' // outgoing, waiting for accept
  | 'connecting' // accepted, negotiating WebRTC
  | 'transferring'
  | 'complete'
  | 'declined'
  | 'cancelled'
  | 'failed';

export interface TransferVM {
  key: string; // local stable key
  transfer_id: string | null; // null until the server issues one (outgoing)
  role: 'sender' | 'receiver';
  peer_user_id: string;
  peer_name: string;
  files: TransferFileMeta[];
  fraction: number;
  status: TransferStatus;
  message?: string;
  bytesPerSec?: number;
  etaSec?: number;
}

export function isTerminal(status: TransferStatus): boolean {
  return (
    status === 'complete' ||
    status === 'declined' ||
    status === 'cancelled' ||
    status === 'failed'
  );
}
