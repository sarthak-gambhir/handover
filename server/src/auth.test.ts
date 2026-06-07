import { describe, it, expect, beforeEach } from 'vitest';
import type { Request, Response } from 'express';
import { store } from './sessions.js';
import { requireMember, requireOwner, cookieName } from './auth.js';
import { config } from './config.js';

function makeReq(slug: string, cookies: Record<string, string>): Request {
  return {
    params: { slug },
    cookies,
    headers: {},
  } as unknown as Request;
}

interface FakeRes {
  statusCode: number;
  body: unknown;
  cookies: Array<{ name: string; value: string; opts: Record<string, unknown> }>;
  cleared: string[];
  status(c: number): FakeRes;
  json(b: unknown): FakeRes;
  cookie(n: string, v: string, o: Record<string, unknown>): FakeRes;
  clearCookie(n: string, o?: Record<string, unknown>): FakeRes;
}

function makeRes(): FakeRes {
  const res: FakeRes = {
    statusCode: 0,
    body: undefined,
    cookies: [],
    cleared: [],
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
    cookie(n, v, o) {
      this.cookies.push({ name: n, value: v, opts: o });
      return this;
    },
    clearCookie(n) {
      this.cleared.push(n);
      return this;
    },
  };
  return res;
}

describe('requireMember', () => {
  beforeEach(() => {
    store.sessions.clear();
    store.tokens.clear();
    store.totalBytesGlobal = 0;
  });

  it('401 when no cookie present', () => {
    const { session } = store.createSession();
    const res = makeRes();
    let called = false;
    requireMember(makeReq(session.slug, {}), res as unknown as Response, () => {
      called = true;
    });
    expect(called).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  it('403 when a cookie for slug A is presented against slug B', () => {
    const a = store.createSession();
    const b = store.createSession();
    // Present A's token under B's cookie name, requesting slug B.
    const cookies = { [cookieName(b.session.slug)]: a.ownerToken };
    const res = makeRes();
    let called = false;
    requireMember(makeReq(b.session.slug, cookies), res as unknown as Response, () => {
      called = true;
    });
    expect(called).toBe(false);
    expect(res.statusCode).toBe(403);
  });

  it('401 when the token is no longer in the map', () => {
    const { session, ownerToken } = store.createSession();
    store.revokeToken(ownerToken);
    const res = makeRes();
    requireMember(
      makeReq(session.slug, { [cookieName(session.slug)]: ownerToken }),
      res as unknown as Response,
      () => undefined,
    );
    expect(res.statusCode).toBe(401);
  });

  it('401 when the token is still pending (knocker, not a member)', () => {
    const { session } = store.createSession();
    const { token } = store.addKnocker(session, 'Alice');
    const res = makeRes();
    requireMember(
      makeReq(session.slug, { [cookieName(session.slug)]: token }),
      res as unknown as Response,
      () => undefined,
    );
    expect(res.statusCode).toBe(401);
  });

  it('passes for a valid member and refreshes the cookie (sliding window)', () => {
    const { session, ownerToken, ownerUserId } = store.createSession();
    const req = makeReq(session.slug, { [cookieName(session.slug)]: ownerToken });
    const res = makeRes();
    let called = false;
    requireMember(req, res as unknown as Response, () => {
      called = true;
    });
    expect(called).toBe(true);
    expect(req.user_id).toBe(ownerUserId);
    const refreshed = res.cookies.find((c) => c.name === cookieName(session.slug));
    expect(refreshed?.value).toBe(ownerToken);
    expect(refreshed?.opts.maxAge).toBe(config.memberCookieMaxAgeS * 1000);
  });

  it('an admitted knocker token refreshes with the member Max-Age (cookie upgrade)', () => {
    // Knock sets a short-lived pending cookie; admission upgrades the token to
    // member. The first authenticated request must re-issue the cookie with the
    // longer member Max-Age so HTTP auth does not expire after the pending TTL.
    const { session } = store.createSession();
    const { knocker } = store.addKnocker(session, 'Alice');
    const member = store.admitKnocker(session, knocker.knock_id)!;
    const token = member.session_token;

    const req = makeReq(session.slug, { [cookieName(session.slug)]: token });
    const res = makeRes();
    let called = false;
    requireMember(req, res as unknown as Response, () => {
      called = true;
    });
    expect(called).toBe(true);
    const refreshed = res.cookies.find((c) => c.name === cookieName(session.slug));
    expect(refreshed?.value).toBe(token);
    expect(refreshed?.opts.maxAge).toBe(config.memberCookieMaxAgeS * 1000);
  });

  it('multi-session scoping: revoking one session does not affect the other', () => {
    const a = store.createSession();
    const b = store.createSession();
    store.revokeToken(a.ownerToken);

    const resA = makeRes();
    requireMember(
      makeReq(a.session.slug, { [cookieName(a.session.slug)]: a.ownerToken }),
      resA as unknown as Response,
      () => undefined,
    );
    expect(resA.statusCode).toBe(401);

    const resB = makeRes();
    let calledB = false;
    requireMember(
      makeReq(b.session.slug, { [cookieName(b.session.slug)]: b.ownerToken }),
      resB as unknown as Response,
      () => {
        calledB = true;
      },
    );
    expect(calledB).toBe(true);
  });

  it('kick invalidation: a removed member token yields 401', () => {
    const { session } = store.createSession();
    const member = store.admitKnocker(
      session,
      store.addKnocker(session, 'Bob').knocker.knock_id,
    )!;
    const token = member.session_token;
    store.removeMember(session, member.user_id);
    const res = makeRes();
    requireMember(
      makeReq(session.slug, { [cookieName(session.slug)]: token }),
      res as unknown as Response,
      () => undefined,
    );
    expect(res.statusCode).toBe(401);
  });
});

describe('requireOwner', () => {
  beforeEach(() => {
    store.sessions.clear();
    store.tokens.clear();
  });

  it('403 for a member who is not the owner', () => {
    const { session } = store.createSession();
    const member = store.admitKnocker(
      session,
      store.addKnocker(session, 'Bob').knocker.knock_id,
    )!;
    const res = makeRes();
    let called = false;
    requireOwner(
      makeReq(session.slug, { [cookieName(session.slug)]: member.session_token }),
      res as unknown as Response,
      () => {
        called = true;
      },
    );
    expect(called).toBe(false);
    expect(res.statusCode).toBe(403);
  });

  it('passes for the owner', () => {
    const { session, ownerToken } = store.createSession();
    const res = makeRes();
    let called = false;
    requireOwner(
      makeReq(session.slug, { [cookieName(session.slug)]: ownerToken }),
      res as unknown as Response,
      () => {
        called = true;
      },
    );
    expect(called).toBe(true);
  });
});
