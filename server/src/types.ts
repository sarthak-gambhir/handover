export type Knocker = {
  knock_id: string; // random 16-byte hex
  display_name: string;
  session_token: string; // pending token, set as cookie on knock
  socket_id: string | null; // their waiting-screen socket
  created_at: number;
};

export type Member = {
  user_id: string; // SERVER-generated UUID (issued at admit / create)
  display_name: string;
  session_token: string; // 32 random bytes, set as HttpOnly cookie
  tab_id: string | null; // bound to one tab; null when no socket connected
  socket_id: string | null; // routing handle only (not auth); null when reconnecting
  is_owner: boolean;
  joined_at: number;
  last_seen: number;
  offline_grace_timer?: ReturnType<typeof setTimeout> | null;
};

export type Invite = {
  code: string; // random base64url token, used as the map key
  created_at: number;
  expires_at: number; // single-use; also pruned by the sweeper once past this
};

export type BucketEntry = {
  id: string; // random 16-byte hex
  name: string; // canonicalised filename
  size: number;
  content_type: string;
  data: Buffer;
  uploader_id: string; // member user_id
  created_at: number;
};

export type TransferStateName =
  | "requested"
  | "accepted"
  | "declined"
  | "offering"
  | "answered"
  | "closed"
  | "cancelled"
  | "expired";

export type TransferFileMeta = { name: string; size: number };

export type TransferState = {
  transfer_id: string; // SERVER-generated random 16-byte hex
  from_user_id: string; // pinned at request time (NOT socket-bound)
  to_user_id: string; // pinned at request time
  state: TransferStateName;
  files: TransferFileMeta[];
  created_at: number;
  state_changed_at: number; // for per-state timeout
  state_log: Array<{ state: TransferStateName; at: number }>;
};

export type Session = {
  slug: string; // canonical lowercase, "purple-otter-77"
  owner_user_id: string;
  members: Map<string, Member>; // by user_id
  knockers: Map<string, Knocker>; // by knock_id
  invites: Map<string, Invite>; // single-use invite codes, by code
  bucket: Map<string, BucketEntry>; // by file id
  transfers: Map<string, TransferState>; // by transfer_id
  total_bytes: number;
  last_activity: number;
  owner_disconnected_at: number | null; // for owner grace
  knocking_paused: boolean;
  // Owner-triggered "session compromised" freeze. When true the session is a
  // read-only snapshot: uploads/downloads/deletes/transfers/knock admit are all
  // rejected and in-flight transfers are cancelled.
  frozen: boolean;
  // Outstanding ownership offer; only the named member may accept it, and only
  // while it has not expired. Null when no offer is in flight.
  pending_owner_offer: {
    to_user_id: string;
    from_user_id: string;
    created_at: number;
  } | null;
};

// Public projections (never leak tokens / socket ids / buffers)
export type PublicMember = {
  user_id: string;
  display_name: string;
  is_owner: boolean;
  online: boolean;
};

export type PublicBucketEntry = {
  id: string;
  name: string;
  size: number;
  content_type: string;
  uploader_id: string;
  created_at: number;
};

export const TERMINAL_STATES: ReadonlySet<TransferStateName> = new Set([
  "declined",
  "closed",
  "cancelled",
  "expired",
]);
