# HandOver

> Share content privately — your files, your circle, nobody else invited.

Password-free, owner-admitted, ephemeral file transfer. One user creates a session and shares a slug; others knock and are admitted through a waiting room. Inside a session, every member can either upload to a **shared server bucket** or **send a file directly to another member over WebRTC** (true peer-to-peer, end-to-end, never touches the server). Nothing is persisted — all state lives in memory and dies on session expiry or server restart.

## Quickstart

```bash
npm install
cp server/.env.example server/.env   # optional; sensible defaults otherwise
npm run dev
```

- Client dev server: [http://localhost:5173](http://localhost:5173)
- API + WebSocket server: [http://localhost:3000](http://localhost:3000) (proxied under `/api` in dev)

Dev ports/hosts are configurable: server via `PORT`/`HOST` in `server/.env`, and the Vite dev server via `CLIENT_PORT`/`CLIENT_HOST`/`API_TARGET` in `client/.env` (see `client/.env.example`).

Open the client, click **Create new session**, share the slug, and have a second browser **Knock** to join. As the owner you’ll see the knock in your queue and can admit them.

## How it works

- **Sessions** are identified by a human-readable slug (e.g. `purple-otter-77`) and exist only in server memory.
- **Auth** is cookie-based: each session sets an HttpOnly, Secure, SameSite=Strict `st_<slug>` cookie scoped to `/api`. There are no passwords and no tokens in JS-readable storage. The cookie is refreshed on every authenticated request (sliding window).
- **Admission**: non-owners knock with a display name and wait. The owner admits or rejects from the knock queue, and can pause new knocks.
- **Shared bucket**: files uploaded here pass through the server, are held in memory (subject to caps), and are visible to all members. Uploaders can delete their own files; kicked members’ files are auto-removed.
- **Direct send (P2P)**: a member sends files straight to another member over an encrypted WebRTC data channel. The server only relays SDP/ICE signaling and never sees file bytes. Transfers use a manifest + framed-chunk protocol with backpressure, and stream to disk via the File System Access API where available.
- **Cleanup**: a sweeper expires idle sessions (60 min), un-admitted knocks (5 min), gives a disconnected owner a 60 s grace period, and cancels in-flight transfers when a peer leaves.

## Scripts

| Command             | Description                                            |
| ------------------- | ------------------------------------------------------ |
| `npm run dev`       | Run client + server concurrently                       |
| `npm run build`     | Build server then client                               |
| `npm start`         | Run the built server (serves the built client in prod) |
| `npm test`          | Run the server Vitest suite                            |
| `npm run lint`      | Typecheck both packages                                |
| `npm run typecheck` | Typecheck both packages                                |

## Repository layout

```text
client/   Vite + React + TypeScript SPA (SCSS, no UI library)
server/   Node + Express + Socket.IO (in-memory, TypeScript)
```

## Environment variables

All server config is optional and has defaults (see `server/.env.example`).

| Variable            | Default                 | Description                                                                             |
| ------------------- | ----------------------- | --------------------------------------------------------------------------------------- |
| `PORT`              | `3000`                  | HTTP/WebSocket port                                                                     |
| `HOST`              | `0.0.0.0`               | Bind address. `127.0.0.1` restricts to localhost; a NIC IP binds a single interface     |
| `NODE_ENV`          | `development`           | `production` enables HSTS + HTTP→HTTPS redirect and serves the built client same-origin |
| `CLIENT_ORIGIN`     | `http://localhost:5173` | Allowed CORS origin in dev                                                              |
| `MAX_FILE_BYTES`    | `104857600` (100 MB)    | Per-file upload cap for the shared bucket                                               |
| `MAX_SESSION_BYTES` | `524288000` (500 MB)    | Per-session bucket cap                                                                  |
| `MAX_TOTAL_BYTES`   | `536870912` (512 MB)    | Global in-memory bucket cap across all sessions                                         |
| `TURN_URL`          | —                       | Optional TURN server URL for WebRTC NAT traversal                                       |
| `TURN_USERNAME`     | —                       | TURN username                                                                           |
| `TURN_CREDENTIAL`   | —                       | TURN credential                                                                         |

> **TURN is strongly recommended in production.** Without it, peer-to-peer sends rely on STUN only and will fail for users behind symmetric NATs/strict firewalls. The UI surfaces a clear failure state and suggests the shared bucket as a fallback when a P2P connection can’t be established.

## Browser support

- **Chromium-based browsers (Chrome, Edge)** get the best experience: the receiver streams incoming P2P files straight to disk via the File System Access API (FSAA), so file size is bounded only by disk space.
- **Firefox / Safari** lack FSAA, so received P2P files are buffered **in memory** before download.
  - There is a hard **1 GB** in-memory ceiling for received transfers on these browsers.
  - The incoming-transfer dialog shows a **256 MB memory-floor warning** when FSAA is unavailable and an incoming file is large, and a separate **explicit checkbox** must be ticked to accept any file over **2 GB**.
- WebRTC data channels, the Clipboard API, and modern CSS are required throughout; the app targets current evergreen browsers.

## Security model

- HttpOnly + Secure + SameSite=Strict per-session cookies scoped to `/api`; no credentials in `localStorage`/JS.
- `helmet` with a strict Content Security Policy (`script-src 'self'`, `style-src 'self'`), HSTS in production.
- CORS limited to `CLIENT_ORIGIN`; one active tab per session is enforced over the socket.
- Uploaded filenames are canonicalized server-side (lowercased, kebab-cased, restricted character set); display names are validated (length, no control/bidi/zero-width characters).
- Memory caps are reserved atomically to prevent races past the global/per-session limits.

## Ops notes

- **Health & metrics**: `GET /healthz` returns `200` with JSON metrics (active sessions, members, bucket bytes in use vs. caps, in-flight transfers). Use it for liveness checks and basic capacity monitoring.
- **Verify CSP in production**: load the app and confirm there are no CSP violations in the browser console; check the `Content-Security-Policy` response header is present and that `script-src`/`style-src` are `'self'`.
- **Graceful shutdown**: on `SIGTERM` the server stops accepting connections, notifies members, and clears in-memory state. All data is intentionally lost on restart.
- **Memory sizing**: the bucket lives in process memory. Size `MAX_TOTAL_BYTES` well under the container/host memory limit and run the server with adequate `--max-old-space-size` (the `start` script sets 2048 MB).
- **Dev dependency advisory**: `npm audit` reports a critical advisory (GHSA-5xrq-8626-4rwp) against Vitest. It only applies when the **Vitest UI server** (`vitest --ui`) is running, which this project never does — tests run via `vitest run`. Vitest is a dev-only dependency and is not shipped. Upgrading to the “fixed” v4 line reintroduces a worker-spawn failure when `npm` runs scripts under `cmd.exe` on Windows, so we pin Vitest 3.

## Manual test checklist

### Session lifecycle

- [ ] Create a session; the owner lands in the session view with a slug and an empty bucket.
- [ ] Knock from a second browser; the owner sees it in the knock queue.
- [ ] Admit the knocker; they move from the waiting room into the session.
- [ ] Reject a knocker; they’re returned to home with a message.
- [ ] Pause knocking; new knocks are refused with a clear message.
- [ ] Owner closes the tab; after the 60 s grace period the session ends for everyone.
- [ ] Leave idle for the idle timeout; the session ends.

### Shared bucket

- [ ] Upload a file; it appears for all members with a progress bar, then a flash highlight.
- [ ] Download a file from another member.
- [ ] Delete your own file; others see it disappear. You cannot delete someone else’s file.
- [ ] Exceed the per-session/global cap; the upload fails with a capacity message.

### Owner controls

- [ ] Kick a member; they’re removed immediately and their uploaded files vanish for everyone.
- [ ] Transfer ownership; the target must accept, then badges/controls update for both.
- [ ] Decline an ownership offer; the original owner is notified.

### P2P direct send

- [ ] Send a single file to a member; accept on the other side; progress, speed, and ETA update; the file arrives.
- [ ] Send multiple files (and >8) in one transfer.
- [ ] Decline an incoming transfer; the sender sees “declined”.
- [ ] Cancel mid-transfer from either side; the other peer is notified.
- [ ] The other peer leaves/refreshes mid-transfer; the transfer is cancelled with a “peer left” message.
- [ ] On a network where P2P can’t connect, the transfer surfaces a clear failure state (no infinite spinner).
- [ ] In Firefox/Safari, accepting a >2 GB file requires the confirmation checkbox; the 256 MB memory warning appears for large files.

### Multi-session / auth

- [ ] Two sessions open in separate tabs keep independent cookies and state.
- [ ] Opening the same session in a second tab shows the one-tab-collision banner.
- [ ] A kicked member’s cookie no longer grants access.
