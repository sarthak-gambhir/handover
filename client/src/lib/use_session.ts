import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { PublicMember, PublicBucketEntry } from './api';
import { createSocket, type AppSocket, type TransferFileMeta } from './socket';
import { sessionStore } from './sessionStore';
import { useToast } from '../components/ui/Toast';
import type { Knock } from '../components/KnockQueueItem';
import type { IncomingRequest } from '../components/IncomingTransferModal';
import { SenderConnection, ReceiverConnection, type PeerCallbacks } from './webrtc';
import { type TransferVM, type TransferStatus, isTerminal } from './transfer_types';
import { useBucketUploads } from './use_bucket_uploads';
import { randomId } from './id';

type Conn = SenderConnection | ReceiverConnection;

interface RateSample {
  bytes: number;
  at: number;
}

export function useSession(slug: string) {
  const { toast } = useToast();
  const [status, setStatus] = useState<'connecting' | 'live' | 'fatal'>('connecting');
  const [fatalMessage, setFatalMessage] = useState('');
  const [reconnecting, setReconnecting] = useState(false);
  const [members, setMembers] = useState<PublicMember[]>([]);
  const [bucket, setBucket] = useState<PublicBucketEntry[]>([]);
  const [knockers, setKnockers] = useState<Knock[]>([]);
  const [knockingPaused, setKnockingPaused] = useState(false);
  const [frozen, setFrozenState] = useState(false);
  const [yourUserId, setYourUserId] = useState('');
  const [ownerUserId, setOwnerUserId] = useState('');
  const [transfers, setTransfers] = useState<TransferVM[]>([]);
  const [incoming, setIncoming] = useState<IncomingRequest | null>(null);
  const [ownerOffer, setOwnerOffer] = useState<{ from_user_id: string } | null>(null);
  const [justAdded, setJustAdded] = useState<Set<string>>(new Set());

  const socketRef = useRef<AppSocket | null>(null);
  // Set when this client intentionally leaves so the resulting server-side
  // teardown (session:ended for an owner, forced disconnect) is not surfaced
  // as a "fatal" screen — the user is already on their way to the home page.
  const leavingRef = useRef(false);
  const connRef = useRef<Map<string, Conn>>(new Map());
  const filesRef = useRef<Map<string, File[]>>(new Map());
  const outgoingQueue = useRef<Array<{ key: string; to_user_id: string }>>([]);
  const rateRef = useRef<Map<string, RateSample>>(new Map());

  const {
    uploads,
    uploadFiles: rawUploadFiles,
    deleteFile: rawDeleteFile,
  } = useBucketUploads(slug, yourUserId);

  const isOwner = yourUserId !== '' && yourUserId === ownerUserId;

  // While frozen the session is read-only; refuse mutating actions client-side
  // (the server also rejects them with 423/session_frozen as a backstop).
  const uploadFiles = useCallback(
    (files: File[]) => {
      if (frozen) {
        toast('Session is frozen — uploads are paused.', 'warn');
        return;
      }
      rawUploadFiles(files);
    },
    [frozen, rawUploadFiles, toast],
  );
  const deleteFile = useCallback(
    async (id: string) => {
      if (frozen) {
        toast('Session is frozen — files are locked.', 'warn');
        return;
      }
      await rawDeleteFile(id);
    },
    [frozen, rawDeleteFile, toast],
  );

  const nameOf = useCallback(
    (uid: string) => members.find((m) => m.user_id === uid)?.display_name ?? 'Member',
    [members],
  );

  // ---- transfer VM helpers ----
  const patchTransfer = useCallback((key: string, patch: Partial<TransferVM>) => {
    setTransfers((prev) => prev.map((t) => (t.key === key ? { ...t, ...patch } : t)));
  }, []);

  const patchTransferById = useCallback(
    (transfer_id: string, patch: Partial<TransferVM> | ((t: TransferVM) => Partial<TransferVM>)) => {
      setTransfers((prev) =>
        prev.map((t) =>
          t.transfer_id === transfer_id
            ? { ...t, ...(typeof patch === 'function' ? patch(t) : patch) }
            : t,
        ),
      );
    },
    [],
  );

  const onProgressFor = useCallback(
    (transfer_id: string) => (p: { fraction: number; transferred: number; total: number }) => {
      const now = Date.now();
      const last = rateRef.current.get(transfer_id);
      let bytesPerSec: number | undefined;
      let etaSec: number | undefined;
      if (last && now > last.at) {
        bytesPerSec = ((p.transferred - last.bytes) * 1000) / (now - last.at);
        if (bytesPerSec > 0) etaSec = (p.total - p.transferred) / bytesPerSec;
      }
      rateRef.current.set(transfer_id, { bytes: p.transferred, at: now });
      patchTransferById(transfer_id, { fraction: p.fraction, status: 'transferring', bytesPerSec, etaSec });
    },
    [patchTransferById],
  );

  const setTerminalById = useCallback(
    (transfer_id: string, st: TransferStatus, message?: string) => {
      patchTransferById(transfer_id, { status: st, message });
      connRef.current.get(transfer_id)?.cancel();
      connRef.current.delete(transfer_id);
    },
    [patchTransferById],
  );

  const buildReceiverCallbacks = useCallback(
    (transfer_id: string): PeerCallbacks => ({
      sendOffer: (sdp) => socketRef.current?.emit('webrtc:offer', { transfer_id, sdp }),
      sendAnswer: (sdp) => socketRef.current?.emit('webrtc:answer', { transfer_id, sdp }),
      sendIce: (candidate) => socketRef.current?.emit('webrtc:ice', { transfer_id, candidate }),
      onProgress: onProgressFor(transfer_id),
      onComplete: () => {
        patchTransferById(transfer_id, { status: 'complete', fraction: 1 });
        connRef.current.delete(transfer_id);
      },
      onFailure: (reason, message) => {
        socketRef.current?.emit('transfer:cancel', { transfer_id, reason });
        setTerminalById(transfer_id, 'failed', message);
      },
    }),
    [onProgressFor, patchTransferById, setTerminalById],
  );

  // ---- socket wiring ----
  useEffect(() => {
    const socket = createSocket();
    socketRef.current = socket;

    socket.on('connect', () => {
      // Fires on first connect and on every reconnect; re-identify resyncs
      // state via the server's state:snapshot.
      setReconnecting(false);
      socket.emit('identify', { slug, tab_id: sessionStore.tabId });
    });

    socket.on('disconnect', (reason) => {
      // Ignore client-initiated teardown (unmount, fatal handlers) and the
      // forced disconnect that follows an intentional leave; only show the
      // reconnecting banner for unexpected drops that socket.io will retry.
      if (reason !== 'io client disconnect' && !leavingRef.current) setReconnecting(true);
    });

    socket.on('state:snapshot', (p) => {
      setStatus('live');
      setYourUserId(p.your_user_id);
      setOwnerUserId(p.owner_user_id);
      setKnockingPaused(p.knocking_paused);
      setFrozenState(p.frozen);
      setMembers(p.members);
      setBucket(p.bucket);
      sessionStore.set({ slug, user_id: p.your_user_id, is_owner: p.your_user_id === p.owner_user_id });
      // Knocks set a short-lived (pending) cookie that the WS admission flow
      // never upgrades. Hit the authenticated snapshot endpoint so requireMember
      // re-issues the cookie with the member Max-Age (sliding window). Also runs
      // on every reconnect to keep the HTTP cookie fresh. Fire-and-forget.
      api.snapshot(slug).catch(() => {});
    });

    socket.on('members:list', (p) => setMembers(p.members));
    socket.on('member:joined', (p) =>
      setMembers((prev) =>
        prev.some((m) => m.user_id === p.member.user_id) ? prev : [...prev, p.member],
      ),
    );
    socket.on('member:left', (p) => setMembers((prev) => prev.filter((m) => m.user_id !== p.user_id)));
    socket.on('member:online', (p) =>
      setMembers((prev) => prev.map((m) => (m.user_id === p.user_id ? { ...m, online: true } : m))),
    );
    socket.on('member:offline', (p) =>
      setMembers((prev) => prev.map((m) => (m.user_id === p.user_id ? { ...m, online: false } : m))),
    );

    socket.on('knock:new', (p) =>
      setKnockers((prev) => [...prev, { knock_id: p.knock_id, display_name: p.display_name, created_at: p.created_at }]),
    );
    socket.on('knock:cancelled', (p) => setKnockers((prev) => prev.filter((k) => k.knock_id !== p.knock_id)));
    socket.on('knock:expired', (p) => setKnockers((prev) => prev.filter((k) => k.knock_id !== p.knock_id)));
    socket.on('knocking:paused', (p) => setKnockingPaused(p.paused));
    socket.on('session:frozen', (p) => setFrozenState(p.frozen));

    socket.on('file:added', (p) => {
      setBucket((prev) => (prev.some((e) => e.id === p.entry.id) ? prev : [...prev, p.entry]));
      setJustAdded((prev) => new Set(prev).add(p.entry.id));
      setTimeout(() => {
        setJustAdded((prev) => {
          const next = new Set(prev);
          next.delete(p.entry.id);
          return next;
        });
      }, 1200);
    });
    socket.on('file:removed', (p) => setBucket((prev) => prev.filter((e) => e.id !== p.id)));

    socket.on('owner:changed', (p) => {
      setOwnerUserId(p.new_owner_user_id);
      setMembers((prev) =>
        prev.map((m) => ({ ...m, is_owner: m.user_id === p.new_owner_user_id })),
      );
    });
    socket.on('owner_offered', (p) => setOwnerOffer({ from_user_id: p.from_user_id }));
    socket.on('owner_declined', () => toast('The member declined ownership.', 'warn'));
    socket.on('owner_offer:expired', () => {
      setOwnerOffer((cur) => {
        if (cur) toast('The ownership offer expired.', 'warn');
        return null;
      });
    });

    // ---- P2P signaling ----
    socket.on('transfer:created', (p) => {
      // Prefer the explicit client_ref echoed by the server; fall back to the
      // oldest pending send for this recipient for older servers.
      const q =
        p.client_ref !== undefined
          ? outgoingQueue.current.findIndex((o) => o.key === p.client_ref)
          : outgoingQueue.current.findIndex((o) => o.to_user_id === p.to_user_id);
      if (q === -1) return;
      const { key } = outgoingQueue.current.splice(q, 1)[0];
      const files = filesRef.current.get(key);
      if (files) {
        filesRef.current.delete(key);
        filesRef.current.set(p.transfer_id, files);
      }
      patchTransfer(key, { transfer_id: p.transfer_id });
    });

    socket.on('transfer:request', (p) => {
      setIncoming({
        transfer_id: p.transfer_id,
        from_user_id: p.from_user_id,
        from_name: nameOf(p.from_user_id),
        files: p.files,
      });
    });

    socket.on('transfer:response', async (p) => {
      if (!p.accepted) {
        setTerminalById(p.transfer_id, 'declined');
        toast('Transfer declined.', 'warn');
        return;
      }
      patchTransferById(p.transfer_id, { status: 'connecting' });
      const files = filesRef.current.get(p.transfer_id);
      if (!files) return;
      try {
        const { iceServers } = await api.turn(slug);
        const conn = new SenderConnection(p.transfer_id, files, iceServers, makeSenderCallbacks(p.transfer_id));
        connRef.current.set(p.transfer_id, conn);
        await conn.start();
      } catch {
        setTerminalById(p.transfer_id, 'failed', 'Could not start the connection.');
      }
    });

    socket.on('webrtc:offer', async (p) => {
      const conn = connRef.current.get(p.transfer_id);
      if (conn instanceof ReceiverConnection) await conn.acceptOffer(p.sdp);
    });
    socket.on('webrtc:answer', async (p) => {
      const conn = connRef.current.get(p.transfer_id);
      if (conn instanceof SenderConnection) await conn.acceptAnswer(p.sdp);
    });
    socket.on('webrtc:ice', async (p) => {
      await connRef.current.get(p.transfer_id)?.addIce(p.candidate);
    });

    socket.on('transfer:cancelled', (p) => {
      setTerminalById(p.transfer_id, 'cancelled', p.reason === 'peer_left' ? 'The other person left.' : 'Cancelled.');
      setIncoming((cur) => (cur?.transfer_id === p.transfer_id ? null : cur));
    });
    socket.on('transfer:expired', (p) => setTerminalById(p.transfer_id, 'failed', 'Timed out.'));
    socket.on('transfer:closed', (p) => patchTransferById(p.transfer_id, { status: 'complete', fraction: 1 }));

    socket.on('kicked', () => {
      setStatus('fatal');
      setFatalMessage('You were removed from this session by the owner.');
      socket.disconnect();
    });
    socket.on('session:ended', () => {
      // The owner who initiates a leave also receives this broadcast; don't
      // flash the fatal screen at someone who chose to leave.
      if (leavingRef.current) return;
      setStatus('fatal');
      setFatalMessage('This session has ended.');
      socket.disconnect();
    });
    socket.on('error', (e) => {
      if (leavingRef.current) return;
      if (e.code === 'already_open_elsewhere') {
        setStatus('fatal');
        setFatalMessage('This session is already open in another tab. Close that tab and reload here.');
        socket.disconnect();
      } else if (e.code === 'unauthorized' || e.code === 'session_not_found') {
        setStatus('fatal');
        setFatalMessage('You are not a member of this session.');
        socket.disconnect();
      }
    });

    function makeSenderCallbacks(transfer_id: string): PeerCallbacks {
      return {
        sendOffer: (sdp) => socket.emit('webrtc:offer', { transfer_id, sdp }),
        sendAnswer: (sdp) => socket.emit('webrtc:answer', { transfer_id, sdp }),
        sendIce: (candidate) => socket.emit('webrtc:ice', { transfer_id, candidate }),
        onProgress: onProgressFor(transfer_id),
        onComplete: () => {
          socket.emit('transfer:complete', { transfer_id });
          patchTransferById(transfer_id, { status: 'complete', fraction: 1 });
          connRef.current.delete(transfer_id);
        },
        onFailure: (reason, message) => {
          socket.emit('transfer:cancel', { transfer_id, reason });
          setTerminalById(transfer_id, 'failed', message);
        },
      };
    }

    return () => {
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
        toast('Session is frozen — transfers are paused.', 'warn');
        return;
      }
      const key = randomId();
      filesRef.current.set(key, files);
      outgoingQueue.current.push({ key, to_user_id: recipient.user_id });
      const meta: TransferFileMeta[] = files.map((f) => ({ name: f.name, size: f.size }));
      setTransfers((prev) => [
        ...prev,
        {
          key,
          transfer_id: null,
          role: 'sender',
          peer_user_id: recipient.user_id,
          peer_name: recipient.display_name,
          files: meta,
          fraction: 0,
          status: 'requesting',
        },
      ]);
      socket.emit('transfer:request', { to_user_id: recipient.user_id, files: meta, client_ref: key });
    },
    [frozen, toast],
  );

  const acceptIncoming = useCallback(
    async (req: IncomingRequest) => {
      const socket = socketRef.current;
      if (!socket) return;
      setIncoming(null);
      setTransfers((prev) => [
        ...prev,
        {
          key: req.transfer_id,
          transfer_id: req.transfer_id,
          role: 'receiver',
          peer_user_id: req.from_user_id,
          peer_name: req.from_name,
          files: req.files,
          fraction: 0,
          status: 'connecting',
        },
      ]);
      try {
        const { iceServers } = await api.turn(slug);
        const conn = new ReceiverConnection(iceServers, buildReceiverCallbacks(req.transfer_id));
        connRef.current.set(req.transfer_id, conn);
        socket.emit('transfer:response', { transfer_id: req.transfer_id, accepted: true });
      } catch {
        // Tell the sender we can't receive instead of leaving it hanging in
        // "connecting" until the server-side accepted-state timeout fires.
        socket.emit('transfer:response', { transfer_id: req.transfer_id, accepted: false });
        setTerminalById(req.transfer_id, 'failed', 'Could not prepare to receive.');
      }
    },
    [slug, setTerminalById, buildReceiverCallbacks],
  );

  const declineIncoming = useCallback((req: IncomingRequest) => {
    socketRef.current?.emit('transfer:response', { transfer_id: req.transfer_id, accepted: false });
    setIncoming(null);
  }, []);

  const cancelTransfer = useCallback((t: TransferVM) => {
    if (t.transfer_id) {
      socketRef.current?.emit('transfer:cancel', { transfer_id: t.transfer_id, reason: 'cancelled' });
      connRef.current.get(t.transfer_id)?.cancel();
      connRef.current.delete(t.transfer_id);
    }
    patchTransfer(t.key, { status: 'cancelled' });
  }, [patchTransfer]);

  const dismissTransfer = useCallback((t: TransferVM) => {
    setTransfers((prev) => prev.filter((x) => x.key !== t.key));
  }, []);

  // ---- owner actions ----
  const admit = useCallback((knock_id: string) => {
    socketRef.current?.emit('admit', { knock_id });
    setKnockers((prev) => prev.filter((k) => k.knock_id !== knock_id));
  }, []);
  const reject = useCallback((knock_id: string) => {
    socketRef.current?.emit('reject', { knock_id });
    setKnockers((prev) => prev.filter((k) => k.knock_id !== knock_id));
  }, []);
  const kick = useCallback((user_id: string) => socketRef.current?.emit('kick', { user_id }), []);
  const makeOwner = useCallback(
    (user_id: string) => socketRef.current?.emit('transfer_ownership', { to_user_id: user_id }),
    [],
  );
  const setPaused = useCallback(
    (paused: boolean) => {
      if (frozen) {
        toast('Session is frozen — unfreeze it to manage knocking.', 'warn');
        return;
      }
      socketRef.current?.emit('knocking:set_paused', { paused });
    },
    [frozen],
  );
  const setFrozen = useCallback(
    (next: boolean) => socketRef.current?.emit('session:set_frozen', { frozen: next }),
    [],
  );
  const deleteOrphanedFiles = useCallback(async () => {
    if (frozen) {
      toast('Session is frozen — files are locked.', 'warn');
      return;
    }
    try {
      const { removed } = await api.deleteOrphanedFiles(slug);
      if (removed === 0) toast('No orphaned files to remove.', 'info');
      else toast(`Removed ${removed} orphaned file${removed === 1 ? '' : 's'}.`, 'success');
    } catch {
      toast('Could not remove orphaned files.', 'danger');
    }
  }, [frozen, slug, toast]);
  const deleteMemberFiles = useCallback(
    async (user_id: string) => {
      if (frozen) {
        toast('Session is frozen — files are locked.', 'warn');
        return;
      }
      try {
        await api.deleteMemberFiles(slug, user_id);
      } catch {
        toast('Could not remove that member’s files.', 'danger');
      }
    },
    [frozen, slug, toast],
  );
  const acceptOwnership = useCallback(() => {
    socketRef.current?.emit('owner_accept');
    setOwnerOffer(null);
  }, []);
  const declineOwnership = useCallback(() => {
    socketRef.current?.emit('owner_decline');
    setOwnerOffer(null);
  }, []);
  const leave = useCallback(
    () =>
      new Promise<void>((resolve) => {
        leavingRef.current = true;
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
        // Always tell the server we're leaving so it can clean up.
        socket.emit('leave', finish);
        // The owner leaving ends the whole session; the server disconnects the
        // room before the ack can come back, so resolve right away and let the
        // caller navigate home instead of waiting out the fallback timeout.
        if (isOwner) {
          finish();
          return;
        }
        // For a regular member, resolve on the server's ack so we don't tear
        // down the socket before 'leave' is processed. Fall back after a short
        // delay if no ack arrives.
        window.setTimeout(finish, 1500);
      }),
    [isOwner],
  );

  const deleteOwnUploads = useCallback(async () => {
    const mine = bucket.filter((e) => e.uploader_id === yourUserId).map((e) => e.id);
    await Promise.allSettled(mine.map((id) => api.deleteFile(slug, id)));
  }, [bucket, yourUserId, slug]);

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
    yourUserId,
    ownerUserId,
    isOwner,
    uploads,
    transfers,
    incoming,
    ownerOffer,
    justAdded,
    hasActiveWork,
    nameOf,
    // actions
    startSend,
    acceptIncoming,
    declineIncoming,
    cancelTransfer,
    dismissTransfer,
    uploadFiles,
    deleteFile,
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
