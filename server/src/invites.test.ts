import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import http from "node:http";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import { router } from "./routes.js";
import { store } from "./sessions.js";
import { cookieName } from "./auth.js";
import { config } from "./config.js";

const app = express();
app.use(cookieParser());
app.use(express.json());
app.use("/api", router);

let server: http.Server;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  store.sessions.clear();
  store.tokens.clear();
  store.totalBytesGlobal = 0;
});

function newOwnerSession() {
  const { session, ownerToken } = store.createSession();
  return { slug: session.slug, token: ownerToken, session };
}

function cookieHeader(slug: string, token: string): string {
  return `${cookieName(slug)}=${token}`;
}

function newMember(
  session: ReturnType<typeof newOwnerSession>["session"],
  name = "Other"
) {
  return store.admitKnocker(
    session,
    store.addKnocker(session, name).knocker.knock_id
  )!;
}

describe("POST /api/sessions/:slug/invites (mint)", () => {
  it("the owner can mint a single-use invite code", async () => {
    const { slug, token } = newOwnerSession();
    const res = await request(server)
      .post(`/api/sessions/${slug}/invites`)
      .set("Cookie", cookieHeader(slug, token));
    expect(res.status).toBe(201);
    expect(typeof res.body.code).toBe("string");
    expect(res.body.code.length).toBeGreaterThan(0);
    expect(res.body.expires_at).toBeGreaterThan(Date.now());
  });

  it("a non-owner member cannot mint an invite", async () => {
    const { slug, session } = newOwnerSession();
    const other = newMember(session);
    const res = await request(server)
      .post(`/api/sessions/${slug}/invites`)
      .set("Cookie", cookieHeader(slug, other.session_token));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("owner_only");
  });

  it("423 session_frozen when minting while the session is frozen", async () => {
    const { slug, token, session } = newOwnerSession();
    session.frozen = true;
    const res = await request(server)
      .post(`/api/sessions/${slug}/invites`)
      .set("Cookie", cookieHeader(slug, token));
    expect(res.status).toBe(423);
    expect(res.body.error).toBe("session_frozen");
  });

  it("429 invite_cap once the session is at the active-invite limit", async () => {
    const { slug, token, session } = newOwnerSession();
    for (let i = 0; i < config.inviteCap; i++) store.createInvite(session);
    const res = await request(server)
      .post(`/api/sessions/${slug}/invites`)
      .set("Cookie", cookieHeader(slug, token));
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("invite_cap");
  });
});

describe("GET /api/sessions/:slug/invites (list) + DELETE (revoke)", () => {
  it("lists active invites for the owner with the cap", async () => {
    const { slug, token, session } = newOwnerSession();
    store.createInvite(session);
    store.createInvite(session);
    const res = await request(server)
      .get(`/api/sessions/${slug}/invites`)
      .set("Cookie", cookieHeader(slug, token));
    expect(res.status).toBe(200);
    expect(res.body.cap).toBe(config.inviteCap);
    expect(res.body.invites).toHaveLength(2);
    expect(typeof res.body.invites[0].code).toBe("string");
    expect(typeof res.body.invites[0].expires_at).toBe("number");
  });

  it("omits expired invites from the list", async () => {
    const { slug, token, session } = newOwnerSession();
    const live = store.createInvite(session)!;
    const dead = store.createInvite(session)!;
    dead.expires_at = Date.now() - 1000;
    const res = await request(server)
      .get(`/api/sessions/${slug}/invites`)
      .set("Cookie", cookieHeader(slug, token));
    expect(res.status).toBe(200);
    expect(res.body.invites).toHaveLength(1);
    expect(res.body.invites[0].code).toBe(live.code);
  });

  it("a non-owner member cannot list invites", async () => {
    const { slug, session } = newOwnerSession();
    const other = newMember(session);
    const res = await request(server)
      .get(`/api/sessions/${slug}/invites`)
      .set("Cookie", cookieHeader(slug, other.session_token));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("owner_only");
  });

  it("the owner can revoke an invite, after which it can no longer be redeemed", async () => {
    const { slug, token, session } = newOwnerSession();
    const invite = store.createInvite(session)!;
    const del = await request(server)
      .delete(`/api/sessions/${slug}/invites/${invite.code}`)
      .set("Cookie", cookieHeader(slug, token));
    expect(del.status).toBe(204);
    expect(session.invites.size).toBe(0);
    const redeem = await request(server)
      .post(`/api/sessions/${slug}/invites/${invite.code}`)
      .send({ display_name: "Guest" });
    expect(redeem.status).toBe(404);
    expect(redeem.body.error).toBe("invite_invalid");
  });

  it("revoking an unknown code returns 404", async () => {
    const { slug, token } = newOwnerSession();
    const res = await request(server)
      .delete(`/api/sessions/${slug}/invites/nope`)
      .set("Cookie", cookieHeader(slug, token));
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("invite_invalid");
  });

  it("a non-owner member cannot revoke an invite", async () => {
    const { slug, session } = newOwnerSession();
    const invite = store.createInvite(session)!;
    const other = newMember(session);
    const res = await request(server)
      .delete(`/api/sessions/${slug}/invites/${invite.code}`)
      .set("Cookie", cookieHeader(slug, other.session_token));
    expect(res.status).toBe(403);
    expect(session.invites.has(invite.code)).toBe(true);
  });
});

describe("POST /api/sessions/:slug/invites/:code (redeem)", () => {
  it("redeems an invite, joins as a member, and sets a member cookie", async () => {
    const { slug, session } = newOwnerSession();
    const invite = store.createInvite(session)!;
    const before = session.members.size;
    const res = await request(server)
      .post(`/api/sessions/${slug}/invites/${invite.code}`)
      .send({ display_name: "Guest" });
    expect(res.status).toBe(200);
    expect(res.body.slug).toBe(slug);
    expect(typeof res.body.user_id).toBe("string");
    expect(session.members.size).toBe(before + 1);
    expect(session.members.get(res.body.user_id)?.display_name).toBe("Guest");
    expect(session.members.get(res.body.user_id)?.is_owner).toBe(false);
    const setCookie = res.headers["set-cookie"] as unknown as
      | string[]
      | undefined;
    expect(setCookie?.some((c) => c.startsWith(`${cookieName(slug)}=`))).toBe(
      true
    );
  });

  it("is single-use: a second redeem of the same code is rejected", async () => {
    const { slug, session } = newOwnerSession();
    const invite = store.createInvite(session)!;
    const first = await request(server)
      .post(`/api/sessions/${slug}/invites/${invite.code}`)
      .send({ display_name: "First" });
    expect(first.status).toBe(200);
    const second = await request(server)
      .post(`/api/sessions/${slug}/invites/${invite.code}`)
      .send({ display_name: "Second" });
    expect(second.status).toBe(404);
    expect(second.body.error).toBe("invite_invalid");
  });

  it("rejects an expired invite code", async () => {
    const { slug, session } = newOwnerSession();
    const invite = store.createInvite(session)!;
    invite.expires_at = Date.now() - 1000;
    const res = await request(server)
      .post(`/api/sessions/${slug}/invites/${invite.code}`)
      .send({ display_name: "Late" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("invite_invalid");
  });

  it("rejects an unknown code", async () => {
    const { slug } = newOwnerSession();
    const res = await request(server)
      .post(`/api/sessions/${slug}/invites/nope`)
      .send({ display_name: "Ghost" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("invite_invalid");
  });

  it("400 when the display name is missing or invalid", async () => {
    const { slug, session } = newOwnerSession();
    const invite = store.createInvite(session)!;
    const res = await request(server)
      .post(`/api/sessions/${slug}/invites/${invite.code}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_display_name");
  });

  it("423 session_frozen when redeeming while the session is frozen", async () => {
    const { slug, session } = newOwnerSession();
    const invite = store.createInvite(session)!;
    session.frozen = true;
    const res = await request(server)
      .post(`/api/sessions/${slug}/invites/${invite.code}`)
      .send({ display_name: "Guest" });
    expect(res.status).toBe(423);
    expect(res.body.error).toBe("session_frozen");
  });

  it("404 session_not_found for an unknown slug", async () => {
    const res = await request(server)
      .post("/api/sessions/no-such-slug-99/invites/abc")
      .send({ display_name: "Guest" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("session_not_found");
  });
});
