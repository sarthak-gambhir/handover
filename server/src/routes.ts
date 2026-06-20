import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import multer from "multer";
import { rateLimit } from "express-rate-limit";
import { config } from "./config.js";
import { store } from "./sessions.js";
import { normalizeSlug } from "./slug.js";
import { knockBodySchema, createSessionBodySchema } from "./validation.js";
import { sanitizeFilename } from "./lib/sanitize_filename.js";
import {
  requireMember,
  requireOwner,
  setSessionCookie,
  clearSessionCookie,
} from "./auth.js";
import { emitToSession, emitToOwner } from "./realtime.js";
import { iceServers } from "./ice.js";
import type { Session } from "./types.js";

// ---- rate limiters -------------------------------------------------------

const createLimiter = rateLimit({
  windowMs: 60_000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "rate_limited" },
});

const knockLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.ip}:${normalizeSlug(req.params.slug ?? "")}`,
  message: { error: "rate_limited" },
});

const inviteLimiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.ip}:${normalizeSlug(req.params.slug ?? "")}`,
  message: { error: "rate_limited" },
});

// ---- multer (memory) -----------------------------------------------------

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxFileBytes, files: 1 },
});

// Reject data-moving routes while the session is frozen ("compromised"). Must
// run after requireMember/requireOwner so req.session is populated.
function blockIfFrozen(req: Request, res: Response, next: NextFunction): void {
  if (req.session?.frozen) {
    res.status(423).json({ error: "session_frozen" });
    return;
  }
  next();
}

// Reject uploads from a member the owner has blocked. Must run after
// requireMember so req.session/req.user_id are populated.
function blockIfMuted(req: Request, res: Response, next: NextFunction): void {
  if (req.user_id && req.session?.blocked_user_ids.has(req.user_id)) {
    res.status(403).json({ error: "blocked" });
    return;
  }
  next();
}

// In read-only mode only the owner may upload to the bucket. Must run after
// requireMember so req.session/req.member are populated.
function blockIfReadOnly(req: Request, res: Response, next: NextFunction): void {
  if (req.session?.read_only && !req.member?.is_owner) {
    res.status(403).json({ error: "read_only" });
    return;
  }
  next();
}

// ---- upload reservation lifecycle ---------------------------------------

interface Reservation {
  session: Session;
  bytes: number;
  done: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      reservation?: Reservation;
    }
  }
}

/** Reserve bytes from the Content-Length header before Multer reads the body. */
function reserveUpload(req: Request, res: Response, next: NextFunction): void {
  const session = req.session!;
  const clHeader = req.headers["content-length"];
  const cl = clHeader ? Number(clHeader) : NaN;
  if (!Number.isFinite(cl) || cl <= 0) {
    res.status(411).json({ error: "length_required" });
    return;
  }
  if (!store.reserveBytes(session, cl)) {
    res.status(507).json({ error: "insufficient_storage" });
    return;
  }
  req.reservation = { session, bytes: cl, done: false };
  const release = () => {
    const r = req.reservation;
    if (r && !r.done) {
      store.releaseBytes(r.session, r.bytes);
      r.done = true;
    }
  };
  // Release on client abort / premature close.
  req.on("aborted", release);
  res.on("close", () => {
    if (!res.writableEnded) release();
  });
  next();
}

export const router = Router();

// Normalise slug params to lowercase for every route that has one.
router.param("slug", (req, _res, next, slug: string) => {
  req.params.slug = normalizeSlug(slug);
  next();
});

// ---- POST /api/sessions --------------------------------------------------

router.post("/sessions", createLimiter, (req: Request, res: Response) => {
  const parsed = createSessionBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_display_name" });
    return;
  }
  const { session, ownerToken, ownerUserId } = store.createSession(
    parsed.data.display_name,
    parsed.data.read_only ?? false
  );
  setSessionCookie(res, session.slug, ownerToken, config.memberCookieMaxAgeS);
  res.status(201).json({ slug: session.slug, owner_user_id: ownerUserId });
});

// ---- POST /api/sessions/:slug/knock --------------------------------------

router.post(
  "/sessions/:slug/knock",
  knockLimiter,
  (req: Request, res: Response) => {
    const parsed = knockBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_display_name" });
      return;
    }
    const session = store.getSession(req.params.slug);
    if (!session) {
      res.status(404).json({ error: "session_not_found" });
      return;
    }
    if (session.frozen) {
      res.status(423).json({ error: "session_frozen" });
      return;
    }
    if (session.knocking_paused) {
      res.status(423).json({ error: "knocking_paused" });
      return;
    }
    if (session.knockers.size >= config.knockQueueCap) {
      res.status(429).json({ error: "knock_queue_full" });
      return;
    }

    const { knocker, token } = store.addKnocker(
      session,
      parsed.data.display_name
    );
    setSessionCookie(res, session.slug, token, config.pendingCookieMaxAgeS);
    emitToOwner(session, "knock:new", {
      knock_id: knocker.knock_id,
      display_name: knocker.display_name,
      created_at: knocker.created_at,
    });
    res.status(201).json({ knock_id: knocker.knock_id });
  }
);

// ---- DELETE /api/sessions/:slug/knock/:knock_id --------------------------

router.delete(
  "/sessions/:slug/knock/:knock_id",
  (req: Request, res: Response) => {
    const slug = req.params.slug;
    const session = store.getSession(slug);
    if (!session) {
      res.status(404).json({ error: "session_not_found" });
      return;
    }
    // Gate on the pending cookie matching this knock_id.
    const cookies = (req.cookies ?? {}) as Record<string, string>;
    const token = cookies[`st_${slug}`];
    const entry = store.lookupToken(token);
    if (
      !entry ||
      entry.status !== "pending" ||
      entry.knock_id !== req.params.knock_id
    ) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    store.removeKnocker(session, req.params.knock_id);
    clearSessionCookie(res, slug);
    emitToOwner(session, "knock:cancelled", { knock_id: req.params.knock_id });
    res.status(204).end();
  }
);

// ---- POST /api/sessions/:slug/invites (owner mints invite) ---------------

router.post(
  "/sessions/:slug/invites",
  inviteLimiter,
  requireOwner,
  blockIfFrozen,
  (req: Request, res: Response) => {
    const session = req.session!;
    const invite = store.createInvite(session);
    if (!invite) {
      res.status(429).json({ error: "invite_cap" });
      return;
    }
    res.status(201).json({ code: invite.code, expires_at: invite.expires_at });
  }
);

// ---- GET /api/sessions/:slug/invites (owner lists active invites) --------

router.get(
  "/sessions/:slug/invites",
  requireOwner,
  (req: Request, res: Response) => {
    const session = req.session!;
    const invites = store.listInvites(session).map((i) => ({
      code: i.code,
      created_at: i.created_at,
      expires_at: i.expires_at,
    }));
    res.json({ invites, cap: config.inviteCap });
  }
);

// ---- DELETE /api/sessions/:slug/invites/:code (owner revokes) ------------

router.delete(
  "/sessions/:slug/invites/:code",
  requireOwner,
  (req: Request, res: Response) => {
    const session = req.session!;
    if (!store.revokeInvite(session, req.params.code)) {
      res.status(404).json({ error: "invite_invalid" });
      return;
    }
    res.status(204).end();
  }
);

// ---- POST /api/sessions/:slug/invites/:code (redeem, public) -------------

router.post(
  "/sessions/:slug/invites/:code",
  inviteLimiter,
  (req: Request, res: Response) => {
    const parsed = knockBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_display_name" });
      return;
    }
    const session = store.getSession(req.params.slug);
    if (!session) {
      res.status(404).json({ error: "session_not_found" });
      return;
    }
    if (session.frozen) {
      res.status(423).json({ error: "session_frozen" });
      return;
    }
    const redeemed = store.redeemInvite(
      session,
      req.params.code,
      parsed.data.display_name
    );
    if (!redeemed) {
      res.status(404).json({ error: "invite_invalid" });
      return;
    }
    setSessionCookie(
      res,
      session.slug,
      redeemed.token,
      config.memberCookieMaxAgeS
    );
    // Tell the owner the invite was consumed so their invite list can refresh.
    emitToOwner(session, "invite:used", {
      code: req.params.code,
      user_id: redeemed.member.user_id,
      display_name: redeemed.member.display_name,
    });
    res.status(200).json({
      slug: session.slug,
      owner_user_id: session.owner_user_id,
      user_id: redeemed.member.user_id,
    });
  }
);

// ---- GET /api/sessions/:slug (snapshot) ----------------------------------

router.get("/sessions/:slug", requireMember, (req: Request, res: Response) => {
  const session = req.session!;
  res.json({
    slug: session.slug,
    owner_user_id: session.owner_user_id,
    knocking_paused: session.knocking_paused,
    frozen: session.frozen,
    read_only: session.read_only,
    you: store.publicMember(req.member!),
    members: store.publicMembers(session),
    bucket: store.publicBucket(session),
  });
});

// ---- POST /api/sessions/:slug/files (upload) -----------------------------

router.post(
  "/sessions/:slug/files",
  requireMember,
  blockIfMuted,
  blockIfReadOnly,
  blockIfFrozen,
  reserveUpload,
  (req: Request, res: Response, next: NextFunction) => {
    upload.single("file")(req, res, (err: unknown) => {
      if (err) {
        const r = req.reservation;
        if (r && !r.done) {
          store.releaseBytes(r.session, r.bytes);
          r.done = true;
        }
        const code = (err as { code?: string }).code;
        if (code === "LIMIT_FILE_SIZE") {
          res.status(413).json({ error: "file_too_large" });
          return;
        }
        res.status(400).json({ error: "upload_failed" });
        return;
      }
      next();
    });
  },
  (req: Request, res: Response) => {
    const session = req.session!;
    const r = req.reservation!;
    const file = req.file;
    if (!file) {
      store.releaseBytes(session, r.bytes);
      r.done = true;
      res.status(400).json({ error: "no_file" });
      return;
    }

    // Reconcile the Content-Length estimate against the real file size. A
    // dishonest (under-reported) Content-Length must not let a file slip past
    // the per-session/global caps, so any shortfall is reserved atomically and
    // the upload is rejected if that would exceed a cap.
    if (file.size > r.bytes) {
      const shortfall = file.size - r.bytes;
      if (!store.reserveBytes(session, shortfall)) {
        store.releaseBytes(session, r.bytes);
        r.bytes = 0;
        r.done = true;
        res.status(507).json({ error: "insufficient_storage" });
        return;
      }
    } else if (file.size < r.bytes) {
      store.releaseBytes(session, r.bytes - file.size);
    }
    r.bytes = file.size;
    r.done = true; // reservation is now owned by the bucket entry

    const name = sanitizeFilename(file.originalname);
    const entry = store.addBucketEntry(session, {
      name,
      size: file.size,
      content_type: file.mimetype || "application/octet-stream",
      data: file.buffer,
      uploader_id: req.user_id!,
    });

    const pub = store.publicBucketEntry(entry);
    emitToSession(session.slug, "file:added", { entry: pub });
    res.status(201).json(pub);
  }
);

// ---- GET /api/sessions/:slug/files/:id (download) ------------------------

router.get(
  "/sessions/:slug/files/:id",
  requireMember,
  blockIfFrozen,
  (req: Request, res: Response) => {
    const session = req.session!;
    const entry = session.bucket.get(req.params.id);
    if (!entry) {
      res.status(404).json({ error: "file_not_found" });
      return;
    }
    res.setHeader("Content-Type", entry.content_type);
    res.setHeader("Content-Length", entry.size);
    // entry.name is already canonical ASCII.
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${entry.name}"`
    );
    res.send(entry.data);
  }
);

// ---- DELETE /api/sessions/:slug/files/:id --------------------------------

router.delete(
  "/sessions/:slug/files/:id",
  requireMember,
  blockIfFrozen,
  (req: Request, res: Response) => {
    const session = req.session!;
    const entry = session.bucket.get(req.params.id);
    if (!entry) {
      res.status(404).json({ error: "file_not_found" });
      return;
    }
    // The uploader can always delete their own file; the owner can delete any
    // file (including files orphaned by members who have left).
    if (entry.uploader_id !== req.user_id && !req.member?.is_owner) {
      res.status(403).json({ error: "not_uploader" });
      return;
    }
    store.removeBucketEntry(session, req.params.id);
    emitToSession(session.slug, "file:removed", { id: req.params.id });
    res.status(204).end();
  }
);

// ---- DELETE /api/sessions/:slug/orphaned-files (owner) -------------------

router.delete(
  "/sessions/:slug/orphaned-files",
  requireOwner,
  blockIfFrozen,
  (req: Request, res: Response) => {
    const session = req.session!;
    const ids = store.removeOrphanedFiles(session);
    for (const id of ids) emitToSession(session.slug, "file:removed", { id });
    res.json({ removed: ids.length });
  }
);

// ---- DELETE /api/sessions/:slug/members/:userId/files (owner) ------------

router.delete(
  "/sessions/:slug/members/:userId/files",
  requireOwner,
  blockIfFrozen,
  (req: Request, res: Response) => {
    const session = req.session!;
    const ids = store.removeFilesByUploader(session, req.params.userId);
    for (const id of ids) emitToSession(session.slug, "file:removed", { id });
    res.json({ removed: ids.length });
  }
);

// ---- GET /api/turn -------------------------------------------------------

const START_TIME = Date.now();

/** Unauthenticated health probe; mounted at the app root (`/healthz`). */
export function healthHandler(_req: Request, res: Response): void {
  res.json({
    ok: true,
    uptime_s: Math.floor((Date.now() - START_TIME) / 1000),
    sessions: store.sessions.size,
    members: store.memberCount(),
    transfers_in_flight: store.inFlightTransferCount(),
    total_bytes: store.totalBytesGlobal,
    total_bytes_pct_of_cap: Math.round(
      (store.totalBytesGlobal / config.maxTotalBytes) * 100
    ),
  });
}

router.get("/turn", (req: Request, res: Response) => {
  // requireMember needs a slug param; TURN config is global so we accept any
  // valid member cookie, resolved via the `slug` query param.
  req.params.slug = normalizeSlug((req.query.slug as string) ?? "");
  requireMember(req, res, () => {
    if (req.session?.frozen) {
      res.status(423).json({ error: "session_frozen" });
      return;
    }
    res.json({ iceServers: iceServers() });
  });
});
