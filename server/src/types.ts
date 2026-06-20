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
  // Base64 SPKI of the member's ECDH public key, published on identify. Used by
  // other clients to wrap the bucket content key for this member. The server
  // only relays it; it never holds the symmetric content key. Null until the
  // member's socket has identified.
  pubkey?: string | null;
  // Personal block list: user_ids this member refuses to receive P2P transfers
  // from. Owner-independent; only affects sends directed at this member.
  restricted_user_ids: Set<string>;
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

// A member flagged by one or more peers. Keyed in Session.reports by the
// reported member's user_id; reporters are deduped by their own user_id.
export type Report = {
  reported_user_id: string;
  reporters: Map<string, { reason?: string; at: number }>;
};

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

// ---- activity log ----------------------------------------------------------

export type ActivityType =
  | "upload"
  | "download"
  | "delete"
  | "transfer"
  | "join"
  | "leave"
  | "kick"
  | "block"
  | "unblock"
  | "restrict"
  | "unrestrict"
  | "report";

// Outcome of a P2P transfer activity entry (only set when type === "transfer").
export type ActivityOutcome = "complete" | "declined" | "cancelled" | "failed";

// A single audited event. Names are snapshotted at record time so entries stay
// readable after a member leaves. `files`/`total_bytes` describe file payloads
// (upload/download/delete/transfer); `count` is used for bulk deletes.
export type ActivityEntry = {
  id: string; // random 16-byte hex
  at: number;
  type: ActivityType;
  actor_user_id: string;
  actor_name: string;
  target_user_id?: string;
  target_name?: string;
  files?: { name: string; size: number }[];
  count?: number;
  total_bytes?: number;
  outcome?: ActivityOutcome;
};

export type Session = {
  slug: string; // canonical lowercase, "purple-otter-77"
  owner_user_id: string;
  members: Map<string, Member>; // by user_id
  knockers: Map<string, Knocker>; // by knock_id
  invites: Map<string, Invite>; // single-use invite codes, by code
  bucket: Map<string, BucketEntry>; // by file id
  transfers: Map<string, TransferState>; // by transfer_id
  // Owner "block" list: user_ids barred from P2P-sending to anyone AND from
  // uploading to the shared bucket. Reversible; blocked members may still
  // receive and download.
  blocked_user_ids: Set<string>;
  // Member reports queue, visible only to the owner. Keyed by reported user_id.
  reports: Map<string, Report>;
  // In-memory audit log (ring buffer capped at config.activityCap). Cleared
  // with the session; never persisted.
  activity: ActivityEntry[];
  total_bytes: number;
  last_activity: number;
  owner_disconnected_at: number | null; // for owner grace
  // Precise teardown timer armed when the owner goes offline; ends the session
  // exactly at the grace deadline so the client countdown is truthful. The
  // sweeper remains a backstop. Cleared on owner reconnect / ownership handoff.
  owner_grace_timer: ReturnType<typeof setTimeout> | null;
  knocking_paused: boolean;
  // Owner-triggered "session compromised" freeze. When true the session is a
  // read-only snapshot: uploads/downloads/deletes/transfers/knock admit are all
  // rejected and in-flight transfers are cancelled.
  frozen: boolean;
  // Read-only mode (set at creation, owner-toggleable). When true only the
  // owner may upload to the bucket or P2P-send files; other members can still
  // download from the bucket and receive transfers the owner sends them.
  read_only: boolean;
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
  pubkey?: string | null;
  // True when the owner has blocked this member from sending. Broadcast to all
  // so clients can surface a "blocked" badge.
  blocked?: boolean;
};

// Owner-facing projection of a reported member.
export type PublicReport = {
  user_id: string;
  display_name: string;
  count: number;
  reporters: { display_name: string; reason?: string; at: number }[];
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
