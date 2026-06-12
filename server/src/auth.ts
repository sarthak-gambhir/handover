import type { Request, Response, NextFunction } from "express";
import { config } from "./config.js";
import { store } from "./sessions.js";
import { normalizeSlug } from "./slug.js";
import type { Session, Member } from "./types.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user_id?: string;
      session?: Session;
      member?: Member;
    }
  }
}

/** Per-session cookie name so multiple sessions in different tabs don't clobber. */
export function cookieName(slug: string): string {
  return `st_${normalizeSlug(slug)}`;
}

export function setSessionCookie(
  res: Response,
  slug: string,
  token: string,
  maxAgeSeconds: number
): void {
  res.cookie(cookieName(slug), token, {
    httpOnly: true,
    secure: config.isProd,
    sameSite: "strict",
    path: "/api",
    maxAge: maxAgeSeconds * 1000,
  });
}

export function clearSessionCookie(res: Response, slug: string): void {
  res.clearCookie(cookieName(slug), { path: "/api" });
}

function readToken(req: Request, slug: string): string | undefined {
  const cookies = (req.cookies ?? {}) as Record<string, string>;
  return cookies[cookieName(slug)];
}

/**
 * Resolve a member from the per-session cookie. Attaches `req.user_id`,
 * `req.session`, `req.member`, and re-issues the cookie with a refreshed
 * Max-Age (sliding window). Rejects 401 if not a valid member token, 403 if
 * the cookie's slug doesn't match the requested slug (defence-in-depth).
 */
export function requireMember(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const slug = normalizeSlug(req.params.slug ?? "");
  if (!slug) {
    res.status(400).json({ error: "missing_slug" });
    return;
  }

  const token = readToken(req, slug);
  const entry = store.lookupToken(token);

  if (!entry || !token) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  if (entry.slug !== slug) {
    res.status(403).json({ error: "wrong_session" });
    return;
  }
  if (entry.status !== "member") {
    // Still a pending knocker — not yet a member.
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const session = store.getSession(slug);
  const member = session?.members.get(entry.user_id);
  if (!session || !member) {
    // Token references a session/member that no longer exists.
    store.revokeToken(token);
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  req.user_id = member.user_id;
  req.session = session;
  req.member = member;

  // Sliding-window refresh.
  setSessionCookie(res, slug, token, config.memberCookieMaxAgeS);
  store.touch(session);

  next();
}

export function requireOwner(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  requireMember(req, res, () => {
    if (!req.member?.is_owner) {
      res.status(403).json({ error: "owner_only" });
      return;
    }
    next();
  });
}
