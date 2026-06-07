import { describe, it, expect } from 'vitest';
import { Store } from './sessions.js';
import { config } from './config.js';

function freshMemberSession() {
  const store = new Store();
  const { session, ownerUserId } = store.createSession();
  return { store, session, ownerUserId };
}

describe('Store — session + knocker lifecycle', () => {
  it('creates a session with an owner member and a registered token', () => {
    const { store, session, ownerUserId } = freshMemberSession();
    expect(session.members.size).toBe(1);
    const owner = session.members.get(ownerUserId)!;
    expect(owner.is_owner).toBe(true);
    const entry = store.lookupToken(owner.session_token);
    expect(entry?.status).toBe('member');
  });

  it('admits a knocker, upgrading the pending token to a member token', () => {
    const { store, session } = freshMemberSession();
    const { knocker, token } = store.addKnocker(session, 'Alice');
    expect(store.lookupToken(token)?.status).toBe('pending');

    const member = store.admitKnocker(session, knocker.knock_id)!;
    expect(member.user_id).toBeTruthy();
    expect(member.session_token).toBe(token); // same token, no rotation
    const upgraded = store.lookupToken(token);
    expect(upgraded?.status).toBe('member');
    expect(session.knockers.size).toBe(0);
  });

  it('removeMember purges token and deletes the member bucket files', () => {
    const { store, session } = freshMemberSession();
    const member = store.admitKnocker(session, store.addKnocker(session, 'Bob').knocker.knock_id)!;
    store.reserveBytes(session, 10);
    store.addBucketEntry(session, {
      name: 'f.txt',
      size: 10,
      content_type: 'text/plain',
      data: Buffer.alloc(10),
      uploader_id: member.user_id,
    });
    expect(session.bucket.size).toBe(1);
    store.removeMember(session, member.user_id);
    expect(session.bucket.size).toBe(0);
    expect(store.lookupToken(member.session_token)).toBeUndefined();
    expect(session.total_bytes).toBe(0);
  });

  it('removeMember with purgeFiles=false keeps the leaver\u2019s files (orphaned)', () => {
    const { store, session } = freshMemberSession();
    const member = store.admitKnocker(session, store.addKnocker(session, 'Bob').knocker.knock_id)!;
    store.reserveBytes(session, 10);
    store.addBucketEntry(session, {
      name: 'f.txt',
      size: 10,
      content_type: 'text/plain',
      data: Buffer.alloc(10),
      uploader_id: member.user_id,
    });
    store.removeMember(session, member.user_id, false);
    expect(session.members.has(member.user_id)).toBe(false);
    expect(store.lookupToken(member.session_token)).toBeUndefined();
    // File is retained even though its uploader is gone.
    expect(session.bucket.size).toBe(1);
    expect(session.total_bytes).toBe(10);
  });

  it('removeOrphanedFiles drops only files whose uploader is no longer a member', () => {
    const { store, session, ownerUserId } = freshMemberSession();
    const member = store.admitKnocker(session, store.addKnocker(session, 'Bob').knocker.knock_id)!;
    store.reserveBytes(session, 30);
    store.addBucketEntry(session, {
      name: 'owner.txt', size: 10, content_type: 'text/plain',
      data: Buffer.alloc(10), uploader_id: ownerUserId,
    });
    store.addBucketEntry(session, {
      name: 'm1.txt', size: 10, content_type: 'text/plain',
      data: Buffer.alloc(10), uploader_id: member.user_id,
    });
    store.addBucketEntry(session, {
      name: 'm2.txt', size: 10, content_type: 'text/plain',
      data: Buffer.alloc(10), uploader_id: member.user_id,
    });
    store.removeMember(session, member.user_id, false);

    const removed = store.removeOrphanedFiles(session);
    expect(removed).toHaveLength(2);
    expect(session.bucket.size).toBe(1);
    expect(session.total_bytes).toBe(10);
  });

  it('removeFilesByUploader removes exactly one member\u2019s uploads', () => {
    const { store, session, ownerUserId } = freshMemberSession();
    const member = store.admitKnocker(session, store.addKnocker(session, 'Bob').knocker.knock_id)!;
    store.reserveBytes(session, 20);
    store.addBucketEntry(session, {
      name: 'owner.txt', size: 10, content_type: 'text/plain',
      data: Buffer.alloc(10), uploader_id: ownerUserId,
    });
    store.addBucketEntry(session, {
      name: 'm.txt', size: 10, content_type: 'text/plain',
      data: Buffer.alloc(10), uploader_id: member.user_id,
    });
    const removed = store.removeFilesByUploader(session, member.user_id);
    expect(removed).toHaveLength(1);
    expect(session.bucket.size).toBe(1);
    expect(session.total_bytes).toBe(10);
  });
});

describe('Store — byte reservation', () => {
  it('rejects reservations that exceed the per-session cap', () => {
    const { store, session } = freshMemberSession();
    expect(store.reserveBytes(session, config.maxSessionBytes)).toBe(true);
    expect(store.reserveBytes(session, 1)).toBe(false);
  });

  it('memory-cap race: only the fitting subset of concurrent reserves succeed', () => {
    const store = new Store();
    const { session } = store.createSession();
    // Each reserve is a quarter of the per-session cap + 1 so the 4th fails.
    const chunk = Math.floor(config.maxSessionBytes / 4) + 1;
    const results = [0, 1, 2, 3, 4].map(() => store.reserveBytes(session, chunk));
    const ok = results.filter(Boolean).length;
    expect(ok).toBe(3);
    expect(session.total_bytes).toBeLessThanOrEqual(config.maxSessionBytes);
  });

  it('release restores capacity', () => {
    const { store, session } = freshMemberSession();
    store.reserveBytes(session, 100);
    expect(session.total_bytes).toBe(100);
    store.releaseBytes(session, 100);
    expect(session.total_bytes).toBe(0);
    expect(store.totalBytesGlobal).toBe(0);
  });

  it('enforces the global cap across multiple sessions', () => {
    const store = new Store();
    const a = store.createSession().session;
    const b = store.createSession().session;
    // Fill one session to its per-session cap, then top up a second session to
    // the global cap; any further reservation must be rejected on the global
    // limit even though the second session has room.
    expect(store.reserveBytes(a, config.maxSessionBytes)).toBe(true);
    const remaining = config.maxTotalBytes - config.maxSessionBytes;
    expect(remaining).toBeGreaterThan(0);
    expect(store.reserveBytes(b, remaining)).toBe(true);
    expect(store.totalBytesGlobal).toBe(config.maxTotalBytes);
    expect(store.reserveBytes(b, 1)).toBe(false);
  });
});

describe('Store — sweeper', () => {
  it('drops idle sessions', () => {
    const store = new Store();
    const { session } = store.createSession();
    const now = Date.now();
    session.last_activity = now - config.sessionIdleMs - 1000;
    store.sweep(now);
    expect(store.sessions.has(session.slug)).toBe(false);
  });

  it('ends sessions after the owner-disconnect grace', () => {
    const store = new Store();
    const { session } = store.createSession();
    const now = Date.now();
    session.last_activity = now;
    session.owner_disconnected_at = now - config.ownerGraceMs - 1000;
    store.sweep(now);
    expect(store.sessions.has(session.slug)).toBe(false);
  });

  it('expires knockers older than the TTL and emits knock:expired', () => {
    const store = new Store();
    const { session } = store.createSession();
    const { knocker } = store.addKnocker(session, 'Late');
    const now = Date.now();
    session.last_activity = now;
    knocker.created_at = now - config.knockTtlMs - 1000;

    const events: string[] = [];
    store.on('knock:expired', (e) => events.push(e.knock_id));
    store.sweep(now);
    expect(session.knockers.size).toBe(0);
    expect(events).toContain(knocker.knock_id);
  });

  it('moves hung transfers to expired per-state and emits transfer:expired', () => {
    const store = new Store();
    const { session, ownerUserId } = store.createSession();
    const m = store.admitKnocker(session, store.addKnocker(session, 'B').knocker.knock_id)!;
    const t = store.createTransfer(session, ownerUserId, m.user_id, [{ name: 'a', size: 1 }]);
    const now = Date.now();
    session.last_activity = now;
    t.state_changed_at = now - config.transferTimeouts.requested - 1000;

    const expired: string[] = [];
    store.on('transfer:expired', (e) => expired.push(e.transfer.transfer_id));
    store.sweep(now);
    expect(t.state).toBe('expired');
    expect(expired).toContain(t.transfer_id);
  });

  it('GCs terminal transfers older than the GC window', () => {
    const store = new Store();
    const { session, ownerUserId } = store.createSession();
    const m = store.admitKnocker(session, store.addKnocker(session, 'B').knocker.knock_id)!;
    const t = store.createTransfer(session, ownerUserId, m.user_id, [{ name: 'a', size: 1 }]);
    store.setTransferState(t, 'closed');
    const now = Date.now();
    session.last_activity = now;
    t.state_changed_at = now - config.transferGcMs - 1000;
    store.sweep(now);
    expect(session.transfers.has(t.transfer_id)).toBe(false);
  });
});

describe('Store — transfer cancellation on departure', () => {
  it('cancels every non-terminal transfer a user is part of', () => {
    const store = new Store();
    const { session, ownerUserId } = store.createSession();
    const m = store.admitKnocker(session, store.addKnocker(session, 'B').knocker.knock_id)!;
    const t1 = store.createTransfer(session, ownerUserId, m.user_id, [{ name: 'a', size: 1 }]);
    const t2 = store.createTransfer(session, m.user_id, ownerUserId, [{ name: 'b', size: 1 }]);
    store.setTransferState(t2, 'closed'); // terminal, should be skipped

    const cancelled = store.cancelTransfersForUser(session, m.user_id);
    expect(cancelled.map((c) => c.transfer.transfer_id)).toEqual([t1.transfer_id]);
    expect(t1.state).toBe('cancelled');
    expect(t2.state).toBe('closed');
  });
});
