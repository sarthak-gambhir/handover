# HandOver

> Share content privately — your files, your circle, nobody else invited.

Password-free, owner-admitted, ephemeral file transfer. One user creates a session and shares a slug; others knock and are admitted through a waiting room. Inside a session, every member can either upload to a **shared server bucket** or **send a file directly to another member over WebRTC** (true peer-to-peer, end-to-end, never touches the server). Nothing is persisted — all state lives in memory and dies on session expiry or server restart.

## Quickstart

```bash
npm install
cp server/.env.example server/.env   # optional; sensible defaults otherwise
npm run dev
```

- Client dev server: `https://localhost:5173`
- API + WebSocket server: `http://localhost:3000` (proxied under `/api` in dev)

The Vite dev server runs over **HTTPS** with a self-signed certificate (via `@vitejs/plugin-basic-ssl`) so that a LAN IP counts as a secure context — this keeps the auth cookie and WebCrypto (E2EE) working off `localhost`. Your browser will warn about the self-signed cert the first time; accept it to proceed. Only the browser↔Vite leg is TLS; Vite proxies `/api` to the backend over plain HTTP.

Dev ports/hosts are configurable: server via `PORT`/`HOST` in `server/.env`, and the Vite dev server via `CLIENT_PORT`/`CLIENT_HOST`/`API_TARGET` in `client/.env` (see `client/.env.example`). The proxy target defaults to `http://localhost:${SERVER_PORT}`; if the dev proxy reports `ECONNREFUSED`, make sure the server is running and that `SERVER_PORT`/`API_TARGET` match the server's `PORT` (on some setups you may need `API_TARGET=http://127.0.0.1:<port>` to force IPv4).

Open the client, click **Create new session**, share the slug, and have a second browser **Knock** to join. As the owner you’ll see the knock in your queue and can admit them.

## How it works

- **Sessions** are identified by a human-readable slug (e.g. `purple-otter-77`) and exist only in server memory.
- **Auth** is cookie-based: each session sets an HttpOnly, Secure, SameSite=Strict `st_<slug>` cookie scoped to `/api`. There are no passwords and no tokens in JS-readable storage. The cookie is refreshed on every authenticated request (sliding window).
- **Admission**: the owner enters a display name when creating a session; non-owners knock with a display name and wait. The owner admits or rejects from the knock queue, and can pause new knocks.
- **Invite links**: the owner can mint **single-use** invite links (default TTL 30 min, capped at 10 live per session). Redeeming one with a display name **joins the session directly, bypassing the knock queue**; the code is consumed on use and the owner is notified. Codes can be revoked by the owner and are pruned on expiry. Invites are refused while the session is frozen.
- **Shared bucket**: files uploaded here pass through the server, are held in memory (subject to caps), and are visible to all members. Bucket files are **end-to-end encrypted** — the content key is wrapped per-member to each member's published ECDH public key, so the server stores only ciphertext and never holds the symmetric key. Uploaders can delete their own files, and the **owner can delete any file**. When a member leaves, their uploads are **kept** (orphaned) so others don't lose shared content; the owner can remove a single member's uploads, or clear all orphaned files at once. Kicked members' files are still auto-removed.
- **Direct send (P2P)**: a member sends files straight to another member over an encrypted WebRTC data channel. The server only relays SDP/ICE signaling and never sees file bytes. Transfers use a manifest + framed-chunk protocol with backpressure, and stream to disk via the File System Access API where available.
- **Read-only mode**: set at creation and live-toggleable by the owner. While on, only the owner may upload to the bucket or P2P-send; other members can still download from the bucket and receive transfers the owner sends them. Enforced server-side on uploads and transfer requests.
- **Moderation**: the owner can **kick** a member (removed immediately, their uploads purged) or **block** them (barred from uploading and from P2P-sending to anyone, but still able to download/receive — reversible). Independently, any member can personally **restrict** another, refusing to receive P2P transfers from them (owner-independent). Members can also **report** another member; reports are queued for the owner's eyes only.
- **Activity log**: a per-session in-memory audit log (ring buffer, capped) records uploads, downloads, deletes, transfer outcomes, joins/leaves, and moderation events. Visibility is filtered per viewer: uploads/deletes/joins/leaves/kick/block/unblock are visible to everyone; downloads and transfers only to the actor and target; reports, restrict, and unrestrict are actor-only (the target is kept unaware). The owner sees everything.
- **Ownership transfer**: the owner can offer ownership to another member. The offer must be accepted by that named member and expires if ignored; on acceptance, badges and controls update for both parties.
- **Freeze ("session compromised")**: the owner can freeze the session into a read-only snapshot — uploads, downloads, deletes, transfers, and knock admissions are all rejected and in-flight transfers are cancelled.
- **Cleanup**: a sweeper expires idle sessions (60 min), un-admitted knocks (5 min) and invite codes (30 min), gives a disconnected owner a 60 s grace period, and cancels in-flight transfers when a peer leaves. Leaving with files in the bucket prompts you to delete them or keep them for the others.

## Scripts

| Command             | Description                                            |
| ------------------- | ------------------------------------------------------ |
| `npm run dev`       | Run client + server concurrently                       |
| `npm run build`     | Build server then client                               |
| `npm start`         | Run the built server (serves the built client in prod) |
| `npm test`          | Run the server then client Vitest suites               |
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
- Shared-bucket files are **end-to-end encrypted**: the content key is wrapped to each member's published ECDH public key client-side, so the server stores only ciphertext and never sees the symmetric key. P2P sends are likewise encrypted over the WebRTC data channel and never touch the server.
- `helmet` with a strict Content Security Policy (`script-src 'self'`, `style-src 'self'`), HSTS in production.
- CORS limited to `CLIENT_ORIGIN`; one active tab per session is enforced over the socket.
- Uploaded filenames are canonicalized server-side (lowercased, kebab-cased, restricted character set); display names are validated (length, no control/bidi/zero-width characters).
- Memory caps are reserved atomically to prevent races past the global/per-session limits.

## Ops notes

- **Health & metrics**: `GET /healthz` returns `200` with JSON metrics (active sessions, members, bucket bytes in use vs. caps, in-flight transfers). Use it for liveness checks and basic capacity monitoring.
- **Verify CSP in production**: load the app and confirm there are no CSP violations in the browser console; check the `Content-Security-Policy` response header is present and that `script-src`/`style-src` are `'self'`.
- **Graceful shutdown**: on `SIGTERM` the server stops accepting connections, notifies members, and clears in-memory state. All data is intentionally lost on restart.
- **Memory sizing**: the bucket lives in process memory. Size `MAX_TOTAL_BYTES` well under the container/host memory limit and run the server with adequate `--max-old-space-size` (the `start` script sets 2048 MB).
- **Dev dependency advisory**: `npm audit` reports a critical advisory (GHSA-5xrq-8626-4rwp) against Vitest. It only applies when the **Vitest UI server** (`vitest --ui`) is running, which this project never does — tests run via `vitest run`. Vitest is a dev-only dependency in both the server and client packages and is not shipped. Upgrading to the “fixed” v4 line reintroduces a worker-spawn failure when `npm` runs scripts under `cmd.exe` on Windows, so both packages pin Vitest 3.

## Manual test checklist

### Session lifecycle

- [ ] Create a session; you must enter your name first, then land in the session view with a slug and an empty bucket. Other members see you by that name.
- [ ] Knock from a second browser; the owner sees it in the knock queue.
- [ ] Admit the knocker; they move from the waiting room into the session.
- [ ] Reject a knocker; they’re returned to home with a message.
- [ ] Mint an invite link; redeeming it with a name joins the session directly (no knock), and the owner is notified. Re-using the same link a second time fails (single-use), and a revoked or expired link is rejected.
- [ ] Pause knocking; new knocks are refused with a clear message.
- [ ] Owner closes the tab; after the 60 s grace period the session ends for everyone.
- [ ] Leave idle for the idle timeout; the session ends.

### Shared bucket

- [ ] Upload a file; it appears for all members with a progress bar, then a flash highlight.
- [ ] Download a file from another member.
- [ ] Delete your own file; others see it disappear. A non-owner cannot delete someone else’s file.
- [ ] Exceed the per-session/global cap; the upload fails with a capacity message.
- [ ] A member uploads a file then leaves; the file stays in the bucket (now attributed to a former member).

### Owner controls

- [ ] Kick a member; they’re removed immediately and their uploaded files vanish for everyone.
- [ ] Block a member; they can no longer upload or P2P-send (a “blocked” badge shows for everyone) but can still download/receive. Unblock restores their abilities.
- [ ] As owner, delete a file uploaded by someone else; it disappears for everyone.
- [ ] As owner, use a member’s menu → “Delete all uploads”; all of that member’s files are removed.
- [ ] After a member leaves with files, the owner sees “Delete orphaned (N)”; clicking it clears the left-behind files.
- [ ] Leave as a non-owner with files in the bucket; you’re prompted to delete them or keep them. “Keep & leave” leaves them as orphaned.
- [ ] Transfer ownership; the target must accept, then badges/controls update for both.
- [ ] Decline an ownership offer; the original owner is notified.

### Read-only & freeze

- [ ] Create a session in read-only mode; non-owners see no dropzone or Send button and cannot upload/P2P-send. The owner still can.
- [ ] Toggle read-only on/off live as owner; other members’ upload/send controls appear and disappear accordingly.
- [ ] Freeze the session ("compromised"); uploads, downloads, deletes, transfers, and knock admissions are all rejected, and any in-flight transfer is cancelled.

### Moderation & activity

- [ ] Personally restrict another member; transfers they direct at you are refused, while other members are unaffected.
- [ ] Report a member; the report appears in the owner’s queue only (other members, including the reported one, see nothing).
- [ ] As a non-owner, confirm the activity feed hides others’ downloads/transfers and never shows report/restrict/unrestrict entries; as owner, confirm you see the full log.

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
