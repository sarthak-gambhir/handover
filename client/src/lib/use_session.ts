import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { PublicMember, PublicBucketEntry } from "./api";
import { createSocket, type AppSocket, type TransferFileMeta } from "./socket";
import { sessionStore } from "./sessionStore";
import { useToast } from "../components/ui/Toast";
import type { Knock } from "../components/KnockQueueItem";
import type { IncomingRequest } from "../components/IncomingTransferModal";
import {
  SenderConnection,
  ReceiverConnection,
  type PeerCallbacks,
} from "./webrtc";
import {
  type TransferVM,
  type TransferStatus,
  isTerminal,
} from "./transfer_types";
import { useBucketUploads } from "./use_bucket_uploads";
import { randomId } from "./id";
import * as e2ee from "./e2ee";
import { downloadZip } from "client-zip";

type Conn = SenderConnection | ReceiverConnection;

interface RateSample {
  bytes: number;
  at: number;
}

export function useSession(slug: string) {
  const { toast } = useToast();
  const [status, setStatus] = useState<"connecting" | "live" | "fatal">(
    "connecting"
  );
  const [fatalMessage, setFatalMessage] = useState("");
  const [reconnecting, setReconnecting] = useState(false);
  const [members, setMembers] = useState<PublicMember[]>([]);
  const [bucket, setBucket] = useState<PublicBucketEntry[]>([]);
  const [knockers, setKnockers] = useState<Knock[]>([]);
  const [knockingPaused, setKnockingPaused] = useState(false);
  const [frozen, setFrozenState] = useState(false);
  const [inviteUsed, setInviteUsed] = useState<{
    code: string;
    at: number;
  } | null>(null);
  const [yourUserId, setYourUserId] = useState("");
  const [ownerUserId, setOwnerUserId] = useState("");
  // Absolute local time when the owner-disconnect grace expires (session ends),
  // or null when the owner is present. Drives the countdown banner.
  const [ownerGraceEndsAt, setOwnerGraceEndsAt] = useState<number | null>(null);
  const [transfers, setTransfers] = useState<TransferVM[]>([]);
  // Pending incoming transfer prompts, handled one at a time. New requests
  // queue behind the current one instead of clobbering it; `incoming` is the
  // head shown in the modal.
  const [incomingQueue, setIncomingQueue] = useState<IncomingRequest[]>([]);
  const incoming = incomingQueue[0] ?? null;
  const removeIncoming = useCallback((transfer_id: string) => {
    setIncomingQueue((q) => q.filter((r) => r.transfer_id !== transfer_id));
  }, []);
  const [ownerOffer, setOwnerOffer] = useState<{ from_user_id: string } | null>(
    null
  );
  const [justAdded, setJustAdded] = useState<Set<string>>(new Set());
  // E2EE: the shared bucket content key is encrypted in the browser. `keyReady`
  // gates uploads/downloads until this client holds the key. When SubtleCrypto
  // is unavailable (plain HTTP / insecure context) we can't encrypt, so we
  // treat the bucket as ready and fall back to plaintext.
  const [keyReady, setKeyReady] = useState(!e2ee.e2eeSupported);

  const socketRef = useRef<AppSocket | null>(null);
  const contentKeyRef = useRef<CryptoKey | null>(null);
  const keyRetryRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const keyBootstrapRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Set when this client intentionally leaves so the resulting server-side
  // teardown (session:ended for an owner, forced disconnect) is not surfaced
  // as a "fatal" screen — the user is already on their way to the home page.
  const leavingRef = useRef(false);
  const connRef = useRef<Map<string, Conn>>(new Map());
  const filesRef = useRef<Map<string, File[]>>(new Map());
  const outgoingQueue = useRef<Array<{ key: string; to_user_id: string }>>([]);
  const rateRef = useRef<Map<string, RateSample>>(new Map());

  // Encrypt each file with the session content key before it is uploaded.
  // When E2EE is unavailable the raw file is uploaded unchanged.
  const prepareUpload = useCallback(
    async (file: File): Promise<Blob | File> => {
      if (!e2ee.e2eeSupported) return file;
      const key = contentKeyRef.current;
      if (!key) throw { code: "key_not_ready" };
      return e2ee.encryptFile(file, key);
    },
    []
  );

  const {
    uploads,
    uploadFiles: rawUploadFiles,
    deleteFile: rawDeleteFile,
  } = useBucketUploads(slug, yourUserId, prepareUpload);

  const isOwner = yourUserId !== "" && yourUserId === ownerUserId;

  // While frozen the session is read-only; refuse mutating actions client-side
  // (the server also rejects them with 423/session_frozen as a backstop).
  const uploadFiles = useCallback(
    (files: File[]) => {
      if (frozen) {
        toast("Session is frozen — uploads are paused.", "warn");
        return;
      }
      if (!keyReady) {
        toast(
          "Encryption key is still syncing — try again in a moment.",
          "warn"
        );
        return;
      }
      rawUploadFiles(files);
    },
    [frozen, keyReady, rawUploadFiles, toast]
  );
  const deleteFile = useCallback(
    async (id: string) => {
      if (frozen) {
        toast("Session is frozen — files are locked.", "warn");
        return;
      }
      await rawDeleteFile(id);
    },
    [frozen, rawDeleteFile, toast]
  );

  const nameOf = useCallback(
    (uid: string) =>
      members.find((m) => m.user_id === uid)?.display_name ?? "Member",
    [members]
  );

  // ---- transfer VM helpers ----
  const patchTransfer = useCallback(
    (key: string, patch: Partial<TransferVM>) => {
      setTransfers((prev) =>
        prev.map((t) => (t.key === key ? { ...t, ...patch } : t))
      );
    },
    []
  );

  const patchTransferById = useCallback(
    (
      transfer_id: string,
      patch: Partial<TransferVM> | ((t: TransferVM) => Partial<TransferVM>)
    ) => {
      setTransfers((prev) =>
        prev.map((t) =>
          t.transfer_id === transfer_id
            ? { ...t, ...(typeof patch === "function" ? patch(t) : patch) }
            : t
        )
      );
    },
    []
  );

  const onProgressFor = useCallback(
    (transfer_id: string) =>
      (p: { fraction: number; transferred: number; total: number }) => {
        const now = Date.now();
        const last = rateRef.current.get(transfer_id);
        let bytesPerSec: number | undefined;
        let etaSec: number | undefined;
        if (last && now > last.at) {
          bytesPerSec = ((p.transferred - last.bytes) * 1000) / (now - last.at);
          if (bytesPerSec > 0) etaSec = (p.total - p.transferred) / bytesPerSec;
        }
        rateRef.current.set(transfer_id, { bytes: p.transferred, at: now });
        patchTransferById(transfer_id, {
          fraction: p.fraction,
          status: "transferring",
          bytesPerSec,
          etaSec,
        });
      },
    [patchTransferById]
  );

  const setTerminalById = useCallback(
    (transfer_id: string, st: TransferStatus, message?: string) => {
      patchTransferById(transfer_id, { status: st, message });
      connRef.current.get(transfer_id)?.cancel();
      connRef.current.delete(transfer_id);
    },
    [patchTransferById]
  );

  const buildReceiverCallbacks = useCallback(
    (transfer_id: string): PeerCallbacks => ({
      sendOffer: (sdp) =>
        socketRef.current?.emit("webrtc:offer", { transfer_id, sdp }),
      sendAnswer: (sdp) =>
        socketRef.current?.emit("webrtc:answer", { transfer_id, sdp }),
      sendIce: (candidate) =>
        socketRef.current?.emit("webrtc:ice", { transfer_id, candidate }),
      onProgress: onProgressFor(transfer_id),
      onComplete: () => {
        patchTransferById(transfer_id, { status: "complete", fraction: 1 });
        connRef.current.delete(transfer_id);
      },
      onFailure: (reason, message) => {
        socketRef.current?.emit("transfer:cancel", { transfer_id, reason });
        setTerminalById(transfer_id, "failed", message);
      },
    }),
    [onProgressFor, patchTransferById, setTerminalById]
  );

  // ---- socket wiring ----
  useEffect(() => {
    const socket = createSocket();
    socketRef.current = socket;

    // ---- E2EE content-key acquisition ----
    const clearKeyTimers = () => {
      if (keyRetryRef.current) {
        clearInterval(keyRetryRef.current);
        keyRetryRef.current = null;
      }
      if (keyBootstrapRef.current) {
        clearTimeout(keyBootstrapRef.current);
        keyBootstrapRef.current = null;
      }
    };
    const markKeyReady = () => {
      clearKeyTimers();
      setKeyReady(true);
    };
    const requestKey = async () => {
      try {
        const pubkey = await e2ee.getPublicKeyB64(slug);
        socket.emit("e2ee:request_key", { pubkey });
      } catch {
        /* ignore */
      }
    };
    const bootstrapOwnerKey = async () => {
      if (contentKeyRef.current) return;
      try {
        contentKeyRef.current = await e2ee.generateContentKey(slug);
        markKeyReady();
      } catch {
        /* ignore */
      }
    };
    // Called after each state:snapshot. Loads/derives the content key and, if
    // missing, asks the room for it. The owner bootstraps a fresh key if nobody
    // answers (covers a brand-new session with no other members yet).
    const ensureContentKey = async (
      isOwnerNow: boolean,
      memberCount: number
    ) => {
      if (!e2ee.e2eeSupported) return;
      if (contentKeyRef.current) {
        markKeyReady();
        return;
      }
      const existing = await e2ee.loadContentKey(slug);
      if (existing) {
        contentKeyRef.current = existing;
        markKeyReady();
        return;
      }
      void requestKey();
      if (!keyRetryRef.current) {
        keyRetryRef.current = setInterval(() => {
          if (!contentKeyRef.current) void requestKey();
        }, 3000);
      }
      if (isOwnerNow && !keyBootstrapRef.current) {
        const delay = memberCount <= 1 ? 0 : 2500;
        keyBootstrapRef.current = setTimeout(() => {
          keyBootstrapRef.current = null;
          if (!contentKeyRef.current) void bootstrapOwnerKey();
        }, delay);
      }
    };

    socket.on("connect", () => {
      // Fires on first connect and on every reconnect; re-identify resyncs
      // state via the server's state:snapshot. Publish our E2EE public key so
      // peers can wrap the bucket content key for us.
      setReconnecting(false);
      if (e2ee.e2eeSupported) {
        e2ee
          .getPublicKeyB64(slug)
          .then((pubkey) =>
            socket.emit("identify", {
              slug,
              tab_id: sessionStore.tabId,
              pubkey,
            })
          )
          .catch(() =>
            socket.emit("identify", { slug, tab_id: sessionStore.tabId })
          );
      } else {
        socket.emit("identify", { slug, tab_id: sessionStore.tabId });
      }
    });

    // A peer asks for the content key: if we hold it, wrap it for them.
    socket.on("e2ee:request_key", async (p) => {
      const key = contentKeyRef.current;
      if (!e2ee.e2eeSupported || !key) return;
      try {
        const { wrapped, iv } = await e2ee.wrapContentKey(slug, p.pubkey, key);
        const from_pubkey = await e2ee.getPublicKeyB64(slug);
        socket.emit("e2ee:deliver_key", {
          to_user_id: p.from_user_id,
          from_pubkey,
          wrapped,
          iv,
        });
      } catch {
        /* ignore */
      }
    });

    // A key-holder delivered the wrapped content key to us.
    socket.on("e2ee:key", async (p) => {
      if (!e2ee.e2eeSupported || contentKeyRef.current) return;
      try {
        contentKeyRef.current = await e2ee.unwrapContentKey(
          slug,
          p.from_pubkey,
          p.wrapped,
          p.iv
        );
        markKeyReady();
      } catch {
        /* ignore */
      }
    });

    socket.on("disconnect", (reason) => {
      // Ignore client-initiated teardown (unmount, fatal handlers) and the
      // forced disconnect that follows an intentional leave; only show the
      // reconnecting banner for unexpected drops that socket.io will retry.
      if (reason !== "io client disconnect" && !leavingRef.current)
        setReconnecting(true);
    });

    socket.on("state:snapshot", (p) => {
      setStatus("live");
      setYourUserId(p.your_user_id);
      setOwnerUserId(p.owner_user_id);
      setKnockingPaused(p.knocking_paused);
      setFrozenState(p.frozen);
      setMembers(p.members);
      setBucket(p.bucket);
      setOwnerGraceEndsAt(
        p.owner_grace_ms != null ? Date.now() + p.owner_grace_ms : null
      );
      sessionStore.set({
        slug,
        user_id: p.your_user_id,
        is_owner: p.your_user_id === p.owner_user_id,
      });
      // Knocks set a short-lived (pending) cookie that the WS admission flow
      // never upgrades. Hit the authenticated snapshot endpoint so requireMember
      // re-issues the cookie with the member Max-Age (sliding window). Also runs
      // on every reconnect to keep the HTTP cookie fresh. Fire-and-forget.
      api.snapshot(slug).catch(() => {});
      // Acquire (or bootstrap) the bucket content key now that we know our role.
      void ensureContentKey(
        p.your_user_id === p.owner_user_id,
        p.members.length
      );
    });

    socket.on("members:list", (p) => setMembers(p.members));
    socket.on("member:joined", (p) =>
      setMembers((prev) =>
        prev.some((m) => m.user_id === p.member.user_id)
          ? prev
          : [...prev, p.member]
      )
    );
    socket.on("member:left", (p) => {
      setMembers((prev) => prev.filter((m) => m.user_id !== p.user_id));
      // If the owner themselves left, any pending grace countdown is moot.
      setOwnerUserId((owner) => {
        if (p.user_id === owner) setOwnerGraceEndsAt(null);
        return owner;
      });
    });
    socket.on("member:online", (p) => {
      setMembers((prev) =>
        prev.map((m) => (m.user_id === p.user_id ? { ...m, online: true } : m))
      );
      // The owner reconnected — stop the countdown.
      setOwnerUserId((owner) => {
        if (p.user_id === owner) setOwnerGraceEndsAt(null);
        return owner;
      });
    });
    socket.on("member:offline", (p) =>
      setMembers((prev) =>
        prev.map((m) => (m.user_id === p.user_id ? { ...m, online: false } : m))
      )
    );
    socket.on("owner:offline", (p) =>
      setOwnerGraceEndsAt(Date.now() + p.grace_ms)
    );

    socket.on("knock:new", (p) =>
      setKnockers((prev) => [
        ...prev,
        {
          knock_id: p.knock_id,
          display_name: p.display_name,
          created_at: p.created_at,
        },
      ])
    );
    socket.on("knock:cancelled", (p) =>
      setKnockers((prev) => prev.filter((k) => k.knock_id !== p.knock_id))
    );
    socket.on("knock:expired", (p) =>
      setKnockers((prev) => prev.filter((k) => k.knock_id !== p.knock_id))
    );
    socket.on("knocking:paused", (p) => setKnockingPaused(p.paused));
    socket.on("session:frozen", (p) => setFrozenState(p.frozen));
    socket.on("invite:used", (p) => {
      setInviteUsed({ code: p.code, at: Date.now() });
      toast(`${p.display_name} joined via an invite link.`, "info");
    });

    socket.on("file:added", (p) => {
      setBucket((prev) =>
        prev.some((e) => e.id === p.entry.id) ? prev : [...prev, p.entry]
      );
      setJustAdded((prev) => new Set(prev).add(p.entry.id));
      setTimeout(() => {
        setJustAdded((prev) => {
          const next = new Set(prev);
          next.delete(p.entry.id);
          return next;
        });
      }, 1200);
    });
    socket.on("file:removed", (p) =>
      setBucket((prev) => prev.filter((e) => e.id !== p.id))
    );

    socket.on("owner:changed", (p) => {
      setOwnerUserId(p.new_owner_user_id);
      setMembers((prev) =>
        prev.map((m) => ({
          ...m,
          is_owner: m.user_id === p.new_owner_user_id,
        }))
      );
      // New owner is present — cancel any owner-disconnect countdown.
      setOwnerGraceEndsAt(null);
    });
    socket.on("owner_offered", (p) =>
      setOwnerOffer({ from_user_id: p.from_user_id })
    );
    socket.on("owner_declined", () =>
      toast("The member declined ownership.", "warn")
    );
    socket.on("owner_offer:expired", () => {
      setOwnerOffer((cur) => {
        if (cur) toast("The ownership offer expired.", "warn");
        return null;
      });
    });

    // ---- P2P signaling ----
    socket.on("transfer:created", (p) => {
      // Prefer the explicit client_ref echoed by the server; fall back to the
      // oldest pending send for this recipient for older servers.
      const q =
        p.client_ref !== undefined
          ? outgoingQueue.current.findIndex((o) => o.key === p.client_ref)
          : outgoingQueue.current.findIndex(
              (o) => o.to_user_id === p.to_user_id
            );
      if (q === -1) return;
      const { key } = outgoingQueue.current.splice(q, 1)[0];
      const files = filesRef.current.get(key);
      if (files) {
        filesRef.current.delete(key);
        filesRef.current.set(p.transfer_id, files);
      }
      patchTransfer(key, { transfer_id: p.transfer_id });
    });

    socket.on("transfer:request", (p) => {
      setIncomingQueue((q) =>
        q.some((r) => r.transfer_id === p.transfer_id)
          ? q
          : [
              ...q,
              {
                transfer_id: p.transfer_id,
                from_user_id: p.from_user_id,
                from_name: nameOf(p.from_user_id),
                files: p.files,
              },
            ]
      );
    });

    socket.on("transfer:response", async (p) => {
      if (!p.accepted) {
        setTerminalById(p.transfer_id, "declined");
        toast("Transfer declined.", "warn");
        return;
      }
      const allFiles = filesRef.current.get(p.transfer_id);
      if (!allFiles) return;
      // Honor the receiver's per-file selection: only stream the chosen files.
      // Absent `selected` (older receiver) means send everything.
      const files = p.selected
        ? p.selected
            .filter((i) => i >= 0 && i < allFiles.length)
            .map((i) => allFiles[i])
        : allFiles;
      // The receiver deselected everything — treat it as a decline.
      if (files.length === 0) {
        setTerminalById(p.transfer_id, "declined", "No files were accepted.");
        return;
      }
      filesRef.current.set(p.transfer_id, files);
      patchTransferById(p.transfer_id, {
        status: "connecting",
        files: files.map((f) => ({ name: f.name, size: f.size })),
      });
      try {
        const { iceServers } = await api.turn(slug);
        const conn = new SenderConnection(
          p.transfer_id,
          files,
          iceServers,
          makeSenderCallbacks(p.transfer_id)
        );
        connRef.current.set(p.transfer_id, conn);
        await conn.start();
      } catch {
        setTerminalById(
          p.transfer_id,
          "failed",
          "Could not start the connection."
        );
      }
    });

    socket.on("webrtc:offer", async (p) => {
      const conn = connRef.current.get(p.transfer_id);
      if (conn instanceof ReceiverConnection) await conn.acceptOffer(p.sdp);
    });
    socket.on("webrtc:answer", async (p) => {
      const conn = connRef.current.get(p.transfer_id);
      if (conn instanceof SenderConnection) await conn.acceptAnswer(p.sdp);
    });
    socket.on("webrtc:ice", async (p) => {
      await connRef.current.get(p.transfer_id)?.addIce(p.candidate);
    });

    socket.on("transfer:cancelled", (p) => {
      setTerminalById(
        p.transfer_id,
        "cancelled",
        p.reason === "peer_left" ? "The other person left." : "Cancelled."
      );
      removeIncoming(p.transfer_id);
    });
    socket.on("transfer:expired", (p) =>
      setTerminalById(p.transfer_id, "failed", "Timed out.")
    );
    socket.on("transfer:closed", (p) =>
      patchTransferById(p.transfer_id, { status: "complete", fraction: 1 })
    );

    socket.on("kicked", () => {
      contentKeyRef.current = null;
      void e2ee.clearSession(slug);
      setStatus("fatal");
      setFatalMessage("You were removed from this session by the owner.");
      socket.disconnect();
    });
    socket.on("session:ended", () => {
      // The session is gone for everyone — drop the cached keys either way.
      contentKeyRef.current = null;
      void e2ee.clearSession(slug);
      // The owner who initiates a leave also receives this broadcast; don't
      // flash the fatal screen at someone who chose to leave.
      if (leavingRef.current) return;
      setStatus("fatal");
      setFatalMessage("This session has ended.");
      socket.disconnect();
    });
    socket.on("error", (e) => {
      if (leavingRef.current) return;
      if (e.code === "already_open_elsewhere") {
        setStatus("fatal");
        setFatalMessage(
          "This session is already open in another tab. Close that tab and reload here."
        );
        socket.disconnect();
      } else if (e.code === "unauthorized" || e.code === "session_not_found") {
        setStatus("fatal");
        setFatalMessage("You are not a member of this session.");
        socket.disconnect();
      }
    });

    function makeSenderCallbacks(transfer_id: string): PeerCallbacks {
      return {
        sendOffer: (sdp) => socket.emit("webrtc:offer", { transfer_id, sdp }),
        sendAnswer: (sdp) => socket.emit("webrtc:answer", { transfer_id, sdp }),
        sendIce: (candidate) =>
          socket.emit("webrtc:ice", { transfer_id, candidate }),
        onProgress: onProgressFor(transfer_id),
        onComplete: () => {
          socket.emit("transfer:complete", { transfer_id });
          patchTransferById(transfer_id, { status: "complete", fraction: 1 });
          connRef.current.delete(transfer_id);
        },
        onFailure: (reason, message) => {
          socket.emit("transfer:cancel", { transfer_id, reason });
          setTerminalById(transfer_id, "failed", message);
        },
      };
    }

    return () => {
      clearKeyTimers();
      for (const c of connRef.current.values()) c.cancel();
      connRef.current.clear();
      socket.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  // ---- actions ----
  const startSend = useCallback(
    (recipient: PublicMember, files: File[]) => {
      const socket = socketRef.current;
      if (!socket) return;
      if (frozen) {
        toast("Session is frozen — transfers are paused.", "warn");
        return;
      }
      const key = randomId();
      filesRef.current.set(key, files);
      outgoingQueue.current.push({ key, to_user_id: recipient.user_id });
      const meta: TransferFileMeta[] = files.map((f) => ({
        name: f.name,
        size: f.size,
      }));
      setTransfers((prev) => [
        ...prev,
        {
          key,
          transfer_id: null,
          role: "sender",
          peer_user_id: recipient.user_id,
          peer_name: recipient.display_name,
          files: meta,
          fraction: 0,
          status: "requesting",
        },
      ]);
      socket.emit("transfer:request", {
        to_user_id: recipient.user_id,
        files: meta,
        client_ref: key,
      });
    },
    [frozen, toast]
  );

  const acceptIncoming = useCallback(
    async (req: IncomingRequest, selected: number[], zipName?: string) => {
      const socket = socketRef.current;
      if (!socket) return;
      // Nothing selected is the same as declining.
      if (selected.length === 0) {
        socket.emit("transfer:response", {
          transfer_id: req.transfer_id,
          accepted: false,
        });
        removeIncoming(req.transfer_id);
        return;
      }
      removeIncoming(req.transfer_id);
      // The sender only streams the selected files, so the receiver's row
      // should reflect just those.
      const chosen = selected
        .filter((i) => i >= 0 && i < req.files.length)
        .map((i) => req.files[i]);
      setTransfers((prev) => [
        ...prev,
        {
          key: req.transfer_id,
          transfer_id: req.transfer_id,
          role: "receiver",
          peer_user_id: req.from_user_id,
          peer_name: req.from_name,
          files: chosen,
          fraction: 0,
          status: "connecting",
        },
      ]);
      try {
        const { iceServers } = await api.turn(slug);
        const conn = new ReceiverConnection(
          iceServers,
          buildReceiverCallbacks(req.transfer_id),
          zipName
        );
        connRef.current.set(req.transfer_id, conn);
        socket.emit("transfer:response", {
          transfer_id: req.transfer_id,
          accepted: true,
          selected,
        });
      } catch {
        // Tell the sender we can't receive instead of leaving it hanging in
        // "connecting" until the server-side accepted-state timeout fires.
        socket.emit("transfer:response", {
          transfer_id: req.transfer_id,
          accepted: false,
        });
        setTerminalById(
          req.transfer_id,
          "failed",
          "Could not prepare to receive."
        );
      }
    },
    [slug, setTerminalById, buildReceiverCallbacks, removeIncoming]
  );

  const declineIncoming = useCallback(
    (req: IncomingRequest) => {
      socketRef.current?.emit("transfer:response", {
        transfer_id: req.transfer_id,
        accepted: false,
      });
      removeIncoming(req.transfer_id);
    },
    [removeIncoming]
  );

  const cancelTransfer = useCallback(
    (t: TransferVM) => {
      if (t.transfer_id) {
        socketRef.current?.emit("transfer:cancel", {
          transfer_id: t.transfer_id,
          reason: "cancelled",
        });
        connRef.current.get(t.transfer_id)?.cancel();
        connRef.current.delete(t.transfer_id);
      }
      patchTransfer(t.key, { status: "cancelled" });
    },
    [patchTransfer]
  );

  const dismissTransfer = useCallback((t: TransferVM) => {
    setTransfers((prev) => prev.filter((x) => x.key !== t.key));
  }, []);

  // ---- owner actions ----
  const admit = useCallback((knock_id: string) => {
    socketRef.current?.emit("admit", { knock_id });
    setKnockers((prev) => prev.filter((k) => k.knock_id !== knock_id));
  }, []);
  const reject = useCallback((knock_id: string) => {
    socketRef.current?.emit("reject", { knock_id });
    setKnockers((prev) => prev.filter((k) => k.knock_id !== knock_id));
  }, []);
  const kick = useCallback(
    (user_id: string) => socketRef.current?.emit("kick", { user_id }),
    []
  );
  const makeOwner = useCallback(
    (user_id: string) =>
      socketRef.current?.emit("transfer_ownership", { to_user_id: user_id }),
    []
  );
  const setPaused = useCallback(
    (paused: boolean) => {
      if (frozen) {
        toast("Session is frozen — unfreeze it to manage knocking.", "warn");
        return;
      }
      socketRef.current?.emit("knocking:set_paused", { paused });
    },
    [frozen]
  );
  const setFrozen = useCallback(
    (next: boolean) =>
      socketRef.current?.emit("session:set_frozen", { frozen: next }),
    []
  );
  const deleteOrphanedFiles = useCallback(async () => {
    if (frozen) {
      toast("Session is frozen — files are locked.", "warn");
      return;
    }
    try {
      const { removed } = await api.deleteOrphanedFiles(slug);
      if (removed === 0) toast("No orphaned files to remove.", "info");
      else
        toast(
          `Removed ${removed} orphaned file${removed === 1 ? "" : "s"}.`,
          "success"
        );
    } catch {
      toast("Could not remove orphaned files.", "danger");
    }
  }, [frozen, slug, toast]);
  const deleteMemberFiles = useCallback(
    async (user_id: string) => {
      if (frozen) {
        toast("Session is frozen — files are locked.", "warn");
        return;
      }
      try {
        await api.deleteMemberFiles(slug, user_id);
      } catch {
        toast("Could not remove that member’s files.", "danger");
      }
    },
    [frozen, slug, toast]
  );
  // Fetch a bucket file and decrypt it if it carries our E2EE prefix. Throws on
  // network error; throws "key_not_ready" when an encrypted file can't be
  // opened yet. Shared by single- and multi-file download.
  const fetchDecrypted = useCallback(
    async (entry: PublicBucketEntry): Promise<ArrayBuffer> => {
      const res = await fetch(api.downloadUrl(slug, entry.id), {
        credentials: "include",
      });
      if (!res.ok) throw new Error("download_failed");
      const buf = await res.arrayBuffer();
      if (!e2ee.isEncrypted(buf)) return buf;
      const key = contentKeyRef.current;
      if (!e2ee.e2eeSupported || !key) throw new Error("key_not_ready");
      return e2ee.decryptToBytes(buf, key);
    },
    [slug]
  );

  // Fetch a bucket file, decrypt it if needed, and trigger a browser download.
  // Plaintext files (uploaded without E2EE) are saved as-is.
  const downloadFile = useCallback(
    async (entry: PublicBucketEntry) => {
      if (frozen) {
        toast("Session is frozen — files are locked.", "warn");
        return;
      }
      try {
        const out = await fetchDecrypted(entry);
        e2ee.saveBlob(
          new Blob([out], {
            type: entry.content_type || "application/octet-stream",
          }),
          entry.name
        );
      } catch (err) {
        if (err instanceof Error && err.message === "key_not_ready") {
          toast(
            "Encryption key is still syncing — try again in a moment.",
            "warn"
          );
          return;
        }
        toast("Could not download that file.", "danger");
      }
    },
    [frozen, fetchDecrypted, toast]
  );

  // Fetch + decrypt every selected file and save them together as one .zip, so
  // the user gets a single save prompt instead of one per file.
  const downloadFilesZip = useCallback(
    async (entries: PublicBucketEntry[], zipName?: string) => {
      if (frozen) {
        toast("Session is frozen — files are locked.", "warn");
        return;
      }
      if (entries.length === 0) return;
      if (entries.length === 1) {
        await downloadFile(entries[0]);
        return;
      }
      try {
        // Disambiguate duplicate names (e.g. two "photo.jpg" from different
        // uploaders) so the archive doesn't collide entries.
        const used = new Map<string, number>();
        const uniqueName = (name: string): string => {
          const seen = used.get(name) ?? 0;
          used.set(name, seen + 1);
          if (seen === 0) return name;
          const dot = name.lastIndexOf(".");
          return dot > 0
            ? `${name.slice(0, dot)} (${seen})${name.slice(dot)}`
            : `${name} (${seen})`;
        };
        const files = await Promise.all(
          entries.map(async (entry) => ({
            name: uniqueName(entry.name),
            lastModified: new Date(entry.created_at),
            input: await fetchDecrypted(entry),
          }))
        );
        const blob = await downloadZip(files).blob();
        // Sanitize the user-supplied name: drop any path separators / illegal
        // characters and a trailing ".zip", falling back to a sensible default.
        const fallback = `handover-${slug}`;
        const base =
          (zipName ?? fallback)
            .trim()
            .replace(/\.zip$/i, "")
            .replace(/[\\/:*?"<>|\x00-\x1f]+/g, "_")
            .slice(0, 120)
            .trim() || fallback;
        e2ee.saveBlob(blob, `${base}.zip`);
      } catch (err) {
        if (err instanceof Error && err.message === "key_not_ready") {
          toast(
            "Encryption key is still syncing — try again in a moment.",
            "warn"
          );
          return;
        }
        toast("Could not download those files.", "danger");
      }
    },
    [frozen, fetchDecrypted, downloadFile, slug, toast]
  );

  // Bulk-delete the given bucket files (owner action; selected files may belong
  // to different uploaders). The server emits file:removed for each.
  const deleteFiles = useCallback(
    async (ids: string[]) => {
      if (frozen) {
        toast("Session is frozen — files are locked.", "warn");
        return;
      }
      if (ids.length === 0) return;
      const results = await Promise.allSettled(
        ids.map((id) => api.deleteFile(slug, id))
      );
      const failed = results.filter((r) => r.status === "rejected").length;
      if (failed > 0) {
        toast(
          `Could not delete ${failed} of ${ids.length} file${ids.length === 1 ? "" : "s"}.`,
          "danger"
        );
      }
    },
    [frozen, slug, toast]
  );

  const acceptOwnership = useCallback(() => {
    socketRef.current?.emit("owner_accept");
    setOwnerOffer(null);
  }, []);
  const declineOwnership = useCallback(() => {
    socketRef.current?.emit("owner_decline");
    setOwnerOffer(null);
  }, []);
  const leave = useCallback(
    () =>
      new Promise<void>((resolve) => {
        leavingRef.current = true;
        contentKeyRef.current = null;
        void e2ee.clearSession(slug);
        const socket = socketRef.current;
        if (!socket || socket.disconnected) {
          resolve();
          return;
        }
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        if (isOwner) {
          // The owner leaving ends the whole session. The server tears down the
          // room before any ack can return, so wait for the 'session:ended'
          // broadcast (the owner is in the room and receives it) as proof that
          // 'leave' was processed before we navigate away and disconnect the
          // socket. Resolving immediately here would race the emit against the
          // unmount-driven disconnect: on higher-latency links (LAN/custom IP,
          // still on the polling transport) the 'leave' packet gets dropped and
          // the session only ends after the 60s owner-disconnect grace. Fall
          // back after a short delay so we never hang if the broadcast is lost
          // (the grace timer still ends the session server-side).
          socket.once("session:ended", finish);
          socket.emit("leave", finish);
          window.setTimeout(finish, 3000);
          return;
        }
        // For a regular member, resolve on the server's ack so we don't tear
        // down the socket before 'leave' is processed. Fall back after a short
        // delay if no ack arrives.
        socket.emit("leave", finish);
        window.setTimeout(finish, 1500);
      }),
    [isOwner, slug]
  );

  const deleteOwnUploads = useCallback(async () => {
    if (frozen) {
      toast("Session is frozen — files are locked.", "warn");
      return;
    }
    const mine = bucket
      .filter((e) => e.uploader_id === yourUserId)
      .map((e) => e.id);
    await Promise.allSettled(mine.map((id) => api.deleteFile(slug, id)));
  }, [frozen, bucket, yourUserId, slug, toast]);

  const hasActiveWork =
    uploads.length > 0 || transfers.some((t) => !isTerminal(t.status));

  return {
    status,
    fatalMessage,
    reconnecting,
    members,
    bucket,
    knockers,
    knockingPaused,
    frozen,
    inviteUsed,
    yourUserId,
    ownerUserId,
    ownerGraceEndsAt,
    isOwner,
    uploads,
    transfers,
    incoming,
    ownerOffer,
    justAdded,
    hasActiveWork,
    keyReady,
    // True only when E2EE is actually in effect (secure context + key loaded);
    // drives "end-to-end encrypted" UI copy so we never claim it falsely.
    encryptionActive: e2ee.e2eeSupported && keyReady,
    nameOf,
    // actions
    startSend,
    acceptIncoming,
    declineIncoming,
    cancelTransfer,
    dismissTransfer,
    uploadFiles,
    deleteFile,
    downloadFile,
    downloadFilesZip,
    deleteFiles,
    admit,
    reject,
    kick,
    makeOwner,
    setPaused,
    setFrozen,
    deleteOrphanedFiles,
    deleteMemberFiles,
    deleteOwnUploads,
    acceptOwnership,
    declineOwnership,
    leave,
  };
}
