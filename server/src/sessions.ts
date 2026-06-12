import { EventEmitter } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { config } from "./config.js";
import {
  type Session,
  type Member,
  type Knocker,
  type Invite,
  type BucketEntry,
  type TransferState,
  type TransferStateName,
  type TransferFileMeta,
  type PublicMember,
  type PublicBucketEntry,
  TERMINAL_STATES,
} from "./types.js";
import { normalizeSlug, makeUniqueSlug } from "./slug.js";

function newToken(): string {
  return randomBytes(32).toString("base64url");
}

function newId(): string {
  return randomBytes(16).toString("hex");
}

export type TokenEntry =
  | { token: string; slug: string; status: "pending"; knock_id: string }
  | {
      token: string;
      slug: string;
      status: "member";
      user_id: string;
      is_owner: boolean;
    };

export type StoreEvents = {
  "knock:expired": { slug: string; knock_id: string; socket_id: string | null };
  "session:ended": { slug: string; reason: string };
  "transfer:expired": { slug: string; transfer: TransferState };
  "owner_offer:expired": {
    slug: string;
    to_user_id: string;
    from_user_id: string;
  };
};

/**
 * Central in-memory store. Owns every piece of session state plus the
 * cookie-token index. Emits domain events for the WS layer to broadcast;
 * never imports socket.io itself.
 */
export class Store extends EventEmitter {
  readonly sessions = new Map<string, Session>();
  readonly tokens = new Map<string, TokenEntry>();
  totalBytesGlobal = 0;

  private sweeper: ReturnType<typeof setInterval> | null = null;

  // ---- session lifecycle -------------------------------------------------

  createSession(displayName = "Owner"): {
    session: Session;
    ownerToken: string;
    ownerUserId: string;
  } {
    const slug = makeUniqueSlug((s) => this.sessions.has(s));
    const ownerUserId = randomUUID();
    const ownerToken = newToken();
    const now = Date.now();

    const owner: Member = {
      user_id: ownerUserId,
      display_name: displayName,
      session_token: ownerToken,
      tab_id: null,
      socket_id: null,
      is_owner: true,
      joined_at: now,
      last_seen: now,
      offline_grace_timer: null,
    };

    const session: Session = {
      slug,
      owner_user_id: ownerUserId,
      members: new Map([[ownerUserId, owner]]),
      knockers: new Map(),
      invites: new Map(),
      bucket: new Map(),
      transfers: new Map(),
      total_bytes: 0,
      last_activity: now,
      owner_disconnected_at: null,
      owner_grace_timer: null,
      knocking_paused: false,
      frozen: false,
      pending_owner_offer: null,
    };

    this.sessions.set(slug, session);
    this.tokens.set(ownerToken, {
      token: ownerToken,
      slug,
      status: "member",
      user_id: ownerUserId,
      is_owner: true,
    });
    return { session, ownerToken, ownerUserId };
  }

  getSession(slug: string): Session | undefined {
    return this.sessions.get(normalizeSlug(slug));
  }

  touch(session: Session): void {
    session.last_activity = Date.now();
  }

  endSession(slug: string, reason: string): void {
    const session = this.sessions.get(normalizeSlug(slug));
    if (!session) return;
    // Release global byte accounting.
    this.totalBytesGlobal -= session.total_bytes;
    if (this.totalBytesGlobal < 0) this.totalBytesGlobal = 0;
    // Revoke every token bound to this session.
    for (const [token, entry] of this.tokens) {
      if (entry.slug === session.slug) this.tokens.delete(token);
    }
    // Clear any pending offline timers.
    for (const m of session.members.values()) {
      if (m.offline_grace_timer) clearTimeout(m.offline_grace_timer);
    }
    if (session.owner_grace_timer) clearTimeout(session.owner_grace_timer);
    this.sessions.delete(session.slug);
    this.emit("session:ended", { slug: session.slug, reason });
  }

  // ---- knockers ----------------------------------------------------------

  addKnocker(
    session: Session,
    displayName: string
  ): { knocker: Knocker; token: string } {
    const knock_id = newId();
    const token = newToken();
    const knocker: Knocker = {
      knock_id,
      display_name: displayName,
      session_token: token,
      socket_id: null,
      created_at: Date.now(),
    };
    session.knockers.set(knock_id, knocker);
    this.tokens.set(token, {
      token,
      slug: session.slug,
      status: "pending",
      knock_id,
    });
    this.touch(session);
    return { knocker, token };
  }

  removeKnocker(session: Session, knock_id: string): Knocker | undefined {
    const knocker = session.knockers.get(knock_id);
    if (!knocker) return undefined;
    session.knockers.delete(knock_id);
    this.tokens.delete(knocker.session_token);
    return knocker;
  }

  /**
   * Create a non-owner member bound to `token`, register the token as a member
   * entry, and add them to the roster. Shared by knock-admit and invite-redeem.
   */
  private makeMember(
    session: Session,
    displayName: string,
    token: string
  ): Member {
    const user_id = randomUUID();
    const now = Date.now();
    const member: Member = {
      user_id,
      display_name: displayName,
      session_token: token,
      tab_id: null,
      socket_id: null,
      is_owner: false,
      joined_at: now,
      last_seen: now,
      offline_grace_timer: null,
    };
    session.members.set(user_id, member);
    this.tokens.set(token, {
      token,
      slug: session.slug,
      status: "member",
      user_id,
      is_owner: false,
    });
    this.touch(session);
    return member;
  }

  /** Upgrade a pending knocker into a member; reuses the same token. */
  admitKnocker(session: Session, knock_id: string): Member | undefined {
    const knocker = session.knockers.get(knock_id);
    if (!knocker) return undefined;
    session.knockers.delete(knock_id);
    // Reuse the pending token, upgrading its index entry pending -> member.
    return this.makeMember(
      session,
      knocker.display_name,
      knocker.session_token
    );
  }

  // ---- invites -----------------------------------------------------------

  /** Prune invites that are past their expiry. */
  private pruneInvites(session: Session, now = Date.now()): void {
    for (const [code, invite] of session.invites) {
      if (invite.expires_at <= now) session.invites.delete(code);
    }
  }

  /**
   * Mint a single-use invite code. Returns null if the session already has
   * `inviteCap` live invites. The owner shares the code; redeeming it admits a
   * member directly with no knock.
   */
  createInvite(session: Session): Invite | null {
    const now = Date.now();
    this.pruneInvites(session, now);
    if (session.invites.size >= config.inviteCap) return null;
    const invite: Invite = {
      code: newToken(),
      created_at: now,
      expires_at: now + config.inviteTtlMs,
    };
    session.invites.set(invite.code, invite);
    this.touch(session);
    return invite;
  }

  /** Active (non-expired) invites, newest first. Prunes expired entries. */
  listInvites(session: Session, now = Date.now()): Invite[] {
    this.pruneInvites(session, now);
    return [...session.invites.values()].sort(
      (a, b) => b.created_at - a.created_at
    );
  }

  /** Revoke a specific invite code. Returns true if one was removed. */
  revokeInvite(session: Session, code: string): boolean {
    const removed = session.invites.delete(code);
    if (removed) this.touch(session);
    return removed;
  }

  /**
   * Redeem an invite code: consume it (single-use) and create a fresh member
   * with a new member token. Returns undefined if the code is missing/expired.
   */
  redeemInvite(
    session: Session,
    code: string,
    displayName: string
  ): { member: Member; token: string } | undefined {
    const invite = session.invites.get(code);
    if (!invite || invite.expires_at <= Date.now()) {
      // Drop a stale entry if we happened to find one.
      if (invite) session.invites.delete(code);
      return undefined;
    }
    session.invites.delete(code); // single-use
    const token = newToken();
    const member = this.makeMember(session, displayName, token);
    return { member, token };
  }

  // ---- members -----------------------------------------------------------

  removeMember(
    session: Session,
    user_id: string,
    purgeFiles = true
  ): Member | undefined {
    const member = session.members.get(user_id);
    if (!member) return undefined;
    if (member.offline_grace_timer) clearTimeout(member.offline_grace_timer);
    session.members.delete(user_id);
    this.tokens.delete(member.session_token);
    // Optionally free this member's bucket bytes. When a member leaves cleanly
    // their files are intentionally kept (orphaned) for the owner to manage;
    // on kick they are purged.
    if (purgeFiles) {
      for (const [id, entry] of session.bucket) {
        if (entry.uploader_id === user_id) this.removeBucketEntry(session, id);
      }
    }
    // Drop any ownership offer that involves the departing member.
    if (
      session.pending_owner_offer &&
      (session.pending_owner_offer.to_user_id === user_id ||
        session.pending_owner_offer.from_user_id === user_id)
    ) {
      session.pending_owner_offer = null;
    }
    this.touch(session);
    return member;
  }

  /** Move ownership to another member. Updates flags and token entries. */
  transferOwnership(session: Session, to_user_id: string): boolean {
    const next = session.members.get(to_user_id);
    if (!next) return false;
    const prev = session.members.get(session.owner_user_id);
    if (prev) {
      prev.is_owner = false;
      const prevTok = this.tokens.get(prev.session_token);
      if (prevTok && prevTok.status === "member") prevTok.is_owner = false;
    }
    next.is_owner = true;
    const nextTok = this.tokens.get(next.session_token);
    if (nextTok && nextTok.status === "member") nextTok.is_owner = true;
    session.owner_user_id = to_user_id;
    session.pending_owner_offer = null;
    // A handoff while the previous owner was offline must cancel the pending
    // teardown — the session now has a (present) owner again.
    session.owner_disconnected_at = null;
    if (session.owner_grace_timer) {
      clearTimeout(session.owner_grace_timer);
      session.owner_grace_timer = null;
    }
    this.touch(session);
    return true;
  }

  // ---- tokens ------------------------------------------------------------

  lookupToken(token: string | undefined): TokenEntry | undefined {
    if (!token) return undefined;
    return this.tokens.get(token);
  }

  revokeToken(token: string): void {
    this.tokens.delete(token);
  }

  // ---- byte reservation (atomic, pre-read) -------------------------------

  /**
   * Atomically reserve `size` bytes against per-session and global caps.
   * Returns true if reserved; false if either cap would be exceeded.
   */
  reserveBytes(session: Session, size: number): boolean {
    if (size <= 0) return false;
    if (session.total_bytes + size > config.maxSessionBytes) return false;
    if (this.totalBytesGlobal + size > config.maxTotalBytes) return false;
    session.total_bytes += size;
    this.totalBytesGlobal += size;
    return true;
  }

  releaseBytes(session: Session, size: number): void {
    session.total_bytes -= size;
    if (session.total_bytes < 0) session.total_bytes = 0;
    this.totalBytesGlobal -= size;
    if (this.totalBytesGlobal < 0) this.totalBytesGlobal = 0;
  }

  // ---- bucket ------------------------------------------------------------

  addBucketEntry(
    session: Session,
    entry: Omit<BucketEntry, "id" | "created_at">
  ): BucketEntry {
    const full: BucketEntry = { ...entry, id: newId(), created_at: Date.now() };
    session.bucket.set(full.id, full);
    this.touch(session);
    return full;
  }

  removeBucketEntry(
    session: Session,
    file_id: string
  ): BucketEntry | undefined {
    const entry = session.bucket.get(file_id);
    if (!entry) return undefined;
    session.bucket.delete(file_id);
    this.releaseBytes(session, entry.size);
    this.touch(session);
    return entry;
  }

  /** Remove and return the ids of every file uploaded by `user_id`. */
  removeFilesByUploader(session: Session, user_id: string): string[] {
    const ids: string[] = [];
    for (const [id, entry] of session.bucket) {
      if (entry.uploader_id === user_id) ids.push(id);
    }
    for (const id of ids) this.removeBucketEntry(session, id);
    return ids;
  }

  /** Remove and return the ids of files whose uploader is no longer a member. */
  removeOrphanedFiles(session: Session): string[] {
    const ids: string[] = [];
    for (const [id, entry] of session.bucket) {
      if (!session.members.has(entry.uploader_id)) ids.push(id);
    }
    for (const id of ids) this.removeBucketEntry(session, id);
    return ids;
  }

  // ---- transfers ---------------------------------------------------------

  createTransfer(
    session: Session,
    from_user_id: string,
    to_user_id: string,
    files: TransferFileMeta[]
  ): TransferState {
    const transfer_id = newId();
    const now = Date.now();
    const transfer: TransferState = {
      transfer_id,
      from_user_id,
      to_user_id,
      state: "requested",
      files,
      created_at: now,
      state_changed_at: now,
      state_log: [{ state: "requested", at: now }],
    };
    session.transfers.set(transfer_id, transfer);
    this.touch(session);
    return transfer;
  }

  setTransferState(transfer: TransferState, state: TransferStateName): void {
    const now = Date.now();
    transfer.state = state;
    transfer.state_changed_at = now;
    transfer.state_log.push({ state, at: now });
  }

  /** Cancel every non-terminal transfer a departing peer is part of. */
  cancelTransfersForUser(
    session: Session,
    user_id: string
  ): Array<{ transfer: TransferState; other_user_id: string }> {
    const cancelled: Array<{ transfer: TransferState; other_user_id: string }> =
      [];
    for (const transfer of session.transfers.values()) {
      if (TERMINAL_STATES.has(transfer.state)) continue;
      if (transfer.from_user_id !== user_id && transfer.to_user_id !== user_id)
        continue;
      this.setTransferState(transfer, "cancelled");
      const other =
        transfer.from_user_id === user_id
          ? transfer.to_user_id
          : transfer.from_user_id;
      cancelled.push({ transfer, other_user_id: other });
    }
    return cancelled;
  }

  /** Cancel every non-terminal transfer in the session (used by freeze). */
  cancelAllTransfers(session: Session): Array<{
    transfer: TransferState;
    from_user_id: string;
    to_user_id: string;
  }> {
    const cancelled: Array<{
      transfer: TransferState;
      from_user_id: string;
      to_user_id: string;
    }> = [];
    for (const transfer of session.transfers.values()) {
      if (TERMINAL_STATES.has(transfer.state)) continue;
      this.setTransferState(transfer, "cancelled");
      cancelled.push({
        transfer,
        from_user_id: transfer.from_user_id,
        to_user_id: transfer.to_user_id,
      });
    }
    return cancelled;
  }

  // ---- projections -------------------------------------------------------

  publicMember(m: Member): PublicMember {
    return {
      user_id: m.user_id,
      display_name: m.display_name,
      is_owner: m.is_owner,
      online: m.socket_id !== null,
      pubkey: m.pubkey ?? null,
    };
  }

  publicMembers(session: Session): PublicMember[] {
    return [...session.members.values()].map((m) => this.publicMember(m));
  }

  publicBucketEntry(e: BucketEntry): PublicBucketEntry {
    return {
      id: e.id,
      name: e.name,
      size: e.size,
      content_type: e.content_type,
      uploader_id: e.uploader_id,
      created_at: e.created_at,
    };
  }

  publicBucket(session: Session): PublicBucketEntry[] {
    return [...session.bucket.values()].map((e) => this.publicBucketEntry(e));
  }

  memberCount(): number {
    let n = 0;
    for (const s of this.sessions.values()) n += s.members.size;
    return n;
  }

  /** Count of non-terminal transfers across all sessions (for health metrics). */
  inFlightTransferCount(): number {
    let n = 0;
    for (const s of this.sessions.values()) {
      for (const t of s.transfers.values()) {
        if (!TERMINAL_STATES.has(t.state)) n++;
      }
    }
    return n;
  }

  // ---- sweeper -----------------------------------------------------------

  startSweeper(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => this.sweep(), config.sweepIntervalMs);
    // Don't keep the process alive solely for the sweeper.
    if (typeof this.sweeper.unref === "function") this.sweeper.unref();
  }

  stopSweeper(): void {
    if (this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = null;
    }
  }

  /** One sweep pass. Exposed for deterministic testing with an injected `now`. */
  sweep(now: number = Date.now()): void {
    for (const session of [...this.sessions.values()]) {
      // Idle session expiry.
      if (now - session.last_activity > config.sessionIdleMs) {
        this.endSession(session.slug, "idle_timeout");
        continue;
      }
      // Owner-disconnect grace expiry.
      if (
        session.owner_disconnected_at !== null &&
        now - session.owner_disconnected_at > config.ownerGraceMs
      ) {
        this.endSession(session.slug, "owner_left");
        continue;
      }
      // Ownership-offer TTL.
      if (
        session.pending_owner_offer !== null &&
        now - session.pending_owner_offer.created_at > config.ownerOfferTtlMs
      ) {
        const { to_user_id, from_user_id } = session.pending_owner_offer;
        session.pending_owner_offer = null;
        this.emit("owner_offer:expired", {
          slug: session.slug,
          to_user_id,
          from_user_id,
        });
      }
      // Invite TTL — drop expired single-use codes.
      this.pruneInvites(session, now);
      // Knock TTL.
      for (const knocker of [...session.knockers.values()]) {
        if (now - knocker.created_at > config.knockTtlMs) {
          const socket_id = knocker.socket_id;
          this.removeKnocker(session, knocker.knock_id);
          this.emit("knock:expired", {
            slug: session.slug,
            knock_id: knocker.knock_id,
            socket_id,
          });
        }
      }
      // Transfer per-state timeouts + terminal GC.
      for (const transfer of [...session.transfers.values()]) {
        if (TERMINAL_STATES.has(transfer.state)) {
          if (now - transfer.state_changed_at > config.transferGcMs) {
            session.transfers.delete(transfer.transfer_id);
          }
          continue;
        }
        const timeout = config.transferTimeouts[transfer.state];
        if (
          timeout !== undefined &&
          now - transfer.state_changed_at > timeout
        ) {
          this.setTransferState(transfer, "expired");
          this.emit("transfer:expired", { slug: session.slug, transfer });
        }
      }
    }
  }

  // ---- typed event helpers ----------------------------------------------

  override emit<K extends keyof StoreEvents>(
    event: K,
    payload: StoreEvents[K]
  ): boolean {
    return super.emit(event, payload);
  }

  override on<K extends keyof StoreEvents>(
    event: K,
    listener: (payload: StoreEvents[K]) => void
  ): this {
    return super.on(event, listener);
  }
}

export const store = new Store();
