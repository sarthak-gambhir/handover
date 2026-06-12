import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import { Server as SocketIOServer } from "socket.io";
import { config } from "./config.js";
import { router, healthHandler } from "./routes.js";
import { registerWs } from "./ws.js";
import { setIo } from "./realtime.js";
import { store } from "./sessions.js";

const app = express();
app.set("trust proxy", 1);

// HTTP -> HTTPS redirect in production.
if (config.isProd) {
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (
      req.headers["x-forwarded-proto"] &&
      req.headers["x-forwarded-proto"] !== "https"
    ) {
      res.redirect(301, `https://${req.headers.host}${req.originalUrl}`);
      return;
    }
    next();
  });
}

// Security headers + strict CSP (no 'unsafe-inline' for styles; class-based SCSS only).
app.use(
  helmet({
    hsts: config.isProd
      ? { maxAge: 31_536_000, includeSubDomains: true, preload: true }
      : false,
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
        fontSrc: ["'self'"],
        // WebSocket + API + STUN/TURN need connect-src; '*' kept narrow to self + ws.
        connectSrc: ["'self'", "ws:", "wss:"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);

app.use(
  cors({
    origin: config.clientOrigin,
    credentials: true,
  })
);

app.use(cookieParser());
app.use(express.json({ limit: "64kb" }));

// Minimal request logging — never logs bodies, filenames, or tokens.
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  res.on("finish", () => {
    const len = res.getHeader("content-length") ?? "-";
    console.log(
      `${req.method} ${req.path} ${res.statusCode} ${len}B ${Date.now() - start}ms`
    );
  });
  next();
});

// Health probe (unauthenticated, root-level).
app.get("/healthz", healthHandler);

// API.
app.use("/api", router);

// Serve the built client in production (single origin, no CORS needed).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.resolve(__dirname, "../../client/dist");
if (config.isProd && existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get("*", (_req: Request, res: Response) => {
    res.sendFile(path.join(clientDist, "index.html"));
  });
}

const httpServer = http.createServer(app);

const io = new SocketIOServer(httpServer, {
  path: "/api/ws",
  cors: { origin: config.clientOrigin, credentials: true },
  // Cap inbound message size. Signaling payloads (SDP/ICE) are small; this
  // bounds memory/DoS exposure from a malicious client. File bytes never go
  // over the socket — they flow peer-to-peer over WebRTC.
  maxHttpBufferSize: 256 * 1024,
});
setIo(io);
registerWs(io);

store.startSweeper();

httpServer.listen(config.port, config.host, () => {
  console.log(
    `server listening on ${config.host}:${config.port} (${config.nodeEnv})`
  );
});

// Graceful shutdown.
function shutdown(signal: string): void {
  console.log(`${signal} received — shutting down`);
  store.stopSweeper();
  io.emit("session:ended", { reason: "server_shutdown" });
  io.close();
  httpServer.close(() => process.exit(0));
  // Hard exit if not closed in time.
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

export { app, httpServer, io };
