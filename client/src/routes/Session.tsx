import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { FaCopy, FaRightFromBracket, FaFileLines, FaUsers, FaLock, FaLockOpen, FaTrashCan } from 'react-icons/fa6';
import { useSession } from '../lib/use_session';
import { useToast } from '../components/ui/Toast';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Modal } from '../components/ui/Modal';
import { EmptyState } from '../components/ui/EmptyState';
import { Skeleton } from '../components/ui/Skeleton';
import { MemberRow } from '../components/MemberRow';
import { FileRow } from '../components/FileRow';
import { UploadDropzone } from '../components/UploadDropzone';
import { KnockQueueItem } from '../components/KnockQueueItem';
import { SendFileModal } from '../components/SendFileModal';
import { IncomingTransferModal } from '../components/IncomingTransferModal';
import { TransferProgressRow } from '../components/TransferProgressRow';
import { sessionStore } from '../lib/sessionStore';
import { normalizeSlug, sessionPath } from '../lib/slug';
import { api } from '../lib/api';
import type { PublicMember } from '../lib/api';
import './Session.scss';

export function Session() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { slug = '' } = useParams();
  const cleanSlug = normalizeSlug(slug);
  const s = useSession(cleanSlug);
  const [sendTarget, setSendTarget] = useState<PublicMember | null>(null);
  const [kickTarget, setKickTarget] = useState<PublicMember | null>(null);
  const [makeOwnerTarget, setMakeOwnerTarget] = useState<PublicMember | null>(null);
  const [deleteUploadsTarget, setDeleteUploadsTarget] = useState<PublicMember | null>(null);
  const [confirmOrphaned, setConfirmOrphaned] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);

  const memberIds = new Set(s.members.map((m) => m.user_id));
  const orphanedCount = s.bucket.filter((e) => !memberIds.has(e.uploader_id)).length;
  const ownUploadCount = s.bucket.filter((e) => e.uploader_id === s.yourUserId).length;

  // Warn before leaving with active work.
  useEffect(() => {
    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (s.hasActiveWork) {
        e.preventDefault();
        e.returnValue = '';
      }
    }
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [s.hasActiveWork]);

  async function copyInvite() {
    const url = `${window.location.origin}${sessionPath(cleanSlug)}`;
    try {
      await navigator.clipboard.writeText(url);
      toast('Invite link copied.', 'success');
    } catch {
      toast(url, 'info');
    }
  }

  async function performLeave() {
    await s.leave();
    sessionStore.reset();
    navigate('/');
  }

  async function onLeave() {
    // A non-owner who has uploads is asked whether to delete them first; the
    // owner leaving ends the whole session, so there's nothing to orphan.
    if (!s.isOwner && ownUploadCount > 0) {
      setConfirmLeave(true);
      return;
    }
    await performLeave();
  }

  if (s.status === 'fatal') {
    return (
      <div className="session_fatal">
        <Card title="Session unavailable" helper={s.fatalMessage}>
          <Button onClick={() => navigate('/')}>Back to home</Button>
        </Card>
      </div>
    );
  }

  if (s.status === 'connecting') {
    return (
      <div className="session_loading">
        <Skeleton height={48} />
        <Skeleton height={120} />
        <Skeleton height={200} />
      </div>
    );
  }

  const onlineCount = s.members.filter((m) => m.online).length;

  return (
    <div className="session">
      {s.reconnecting && (
        <div className="session_reconnecting" role="status" aria-live="polite">
          Connection lost — reconnecting…
        </div>
      )}
      <header className="session_header">
        <div className="session_header_info">
          <span className="session_slug">{cleanSlug}</span>
          <span className="session_count">
            {onlineCount}/{s.members.length} online
          </span>
        </div>
        <div className="session_header_actions">
          <Button size="sm" variant="ghost" icon={<FaCopy size={16} />} onClick={copyInvite}>
            Copy invite
          </Button>
          <Button size="sm" variant="danger" icon={<FaRightFromBracket size={16} />} onClick={onLeave}>
            Leave
          </Button>
        </div>
      </header>

      {s.isOwner && (
        <aside className="session_owner_panel">
          <Card>
            <div className="session_owner_head">
              <h2 className="session_owner_title">
                Knock queue {s.knockers.length > 0 && <Badge variant="accent">{s.knockers.length}</Badge>}
              </h2>
              <Button
                size="sm"
                variant="secondary"
                icon={s.knockingPaused ? <FaLock size={16} /> : <FaLockOpen size={16} />}
                onClick={() => s.setPaused(!s.knockingPaused)}
              >
                {s.knockingPaused ? 'Knocking paused' : 'Pause knocking'}
              </Button>
            </div>
            {s.knockers.length === 0 ? (
              <p className="session_owner_empty">No one is waiting.</p>
            ) : (
              <ul className="session_knock_list">
                {s.knockers.map((k) => (
                  <KnockQueueItem key={k.knock_id} knock={k} onAdmit={s.admit} onReject={s.reject} />
                ))}
              </ul>
            )}
          </Card>
        </aside>
      )}

      <div className="session_grid">
        <aside className="session_members">
          <h2 className="session_section_title">
            <FaUsers size={16} /> Members
          </h2>
          <ul className="session_member_list">
            {s.members.map((m) => (
              <MemberRow
                key={m.user_id}
                member={m}
                isYou={m.user_id === s.yourUserId}
                viewerIsOwner={s.isOwner}
                onSend={setSendTarget}
                onKick={setKickTarget}
                onMakeOwner={setMakeOwnerTarget}
                onDeleteUploads={setDeleteUploadsTarget}
              />
            ))}
          </ul>

          {s.transfers.length > 0 && (
            <>
              <h2 className="session_section_title">Transfers</h2>
              <ul className="session_transfer_list">
                {s.transfers.map((t) => (
                  <TransferProgressRow
                    key={t.key}
                    transfer={t}
                    onCancel={s.cancelTransfer}
                    onDismiss={s.dismissTransfer}
                  />
                ))}
              </ul>
            </>
          )}
        </aside>

        <section className="session_bucket">
          <div className="session_bucket_head">
            <h2 className="session_section_title">
              <FaFileLines size={16} /> Shared bucket
            </h2>
            {s.isOwner && orphanedCount > 0 && (
              <Button
                size="sm"
                variant="ghost"
                icon={<FaTrashCan size={16} />}
                onClick={() => setConfirmOrphaned(true)}
              >
                Delete orphaned ({orphanedCount})
              </Button>
            )}
          </div>
          <UploadDropzone onFiles={s.uploadFiles} />

          {s.bucket.length === 0 && s.uploads.length === 0 ? (
            <EmptyState
              icon={<FaFileLines size={32} />}
              title="No files yet"
              helper="Drop one above to share it with everyone in the session."
            />
          ) : (
            <ul className="session_file_list">
              {s.uploads.map((u) => (
                <FileRow
                  key={u.tempId}
                  entry={u.entry}
                  uploaderName="you"
                  isYours
                  justAdded={false}
                  downloadUrl="#"
                  onDelete={() => undefined}
                  progress={u.fraction}
                  onCancelUpload={u.abort}
                />
              ))}
              {s.bucket.map((e) => (
                <FileRow
                  key={e.id}
                  entry={e}
                  uploaderName={s.nameOf(e.uploader_id)}
                  isYours={e.uploader_id === s.yourUserId}
                  canDelete={e.uploader_id === s.yourUserId || s.isOwner}
                  justAdded={s.justAdded.has(e.id)}
                  downloadUrl={api.downloadUrl(cleanSlug, e.id)}
                  onDelete={s.deleteFile}
                />
              ))}
            </ul>
          )}
        </section>
      </div>

      <SendFileModal recipient={sendTarget} onClose={() => setSendTarget(null)} onSend={(r, files) => {
        s.startSend(r, files);
        setSendTarget(null);
      }} />

      <IncomingTransferModal request={s.incoming} onAccept={s.acceptIncoming} onDecline={s.declineIncoming} />

      <Modal
        open={!!kickTarget}
        onClose={() => setKickTarget(null)}
        title={`Kick ${kickTarget?.display_name}?`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setKickTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (kickTarget) s.kick(kickTarget.user_id);
                setKickTarget(null);
              }}
            >
              Kick
            </Button>
          </>
        }
      >
        They’ll be removed immediately and their uploaded files will be deleted for everyone.
      </Modal>

      <Modal
        open={!!makeOwnerTarget}
        onClose={() => setMakeOwnerTarget(null)}
        title={`Make ${makeOwnerTarget?.display_name} the owner?`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setMakeOwnerTarget(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (makeOwnerTarget) s.makeOwner(makeOwnerTarget.user_id);
                setMakeOwnerTarget(null);
              }}
            >
              Transfer ownership
            </Button>
          </>
        }
      >
        You’ll become a regular member. They must accept the offer.
      </Modal>

      <Modal
        open={!!s.ownerOffer}
        onClose={s.declineOwnership}
        locked
        title="You’ve been offered ownership"
        footer={
          <>
            <Button variant="ghost" onClick={s.declineOwnership}>
              Decline
            </Button>
            <Button onClick={s.acceptOwnership}>Accept</Button>
          </>
        }
      >
        {s.ownerOffer && <>{s.nameOf(s.ownerOffer.from_user_id)} wants to transfer ownership to you.</>}
      </Modal>

      <Modal
        open={!!deleteUploadsTarget}
        onClose={() => setDeleteUploadsTarget(null)}
        title={`Delete all of ${deleteUploadsTarget?.display_name}’s uploads?`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleteUploadsTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (deleteUploadsTarget) s.deleteMemberFiles(deleteUploadsTarget.user_id);
                setDeleteUploadsTarget(null);
              }}
            >
              Delete files
            </Button>
          </>
        }
      >
        Every file this member uploaded will be removed from the bucket for everyone.
      </Modal>

      <Modal
        open={confirmOrphaned}
        onClose={() => setConfirmOrphaned(false)}
        title="Delete orphaned files?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmOrphaned(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                s.deleteOrphanedFiles();
                setConfirmOrphaned(false);
              }}
            >
              Delete {orphanedCount} file{orphanedCount === 1 ? '' : 's'}
            </Button>
          </>
        }
      >
        This removes every file whose uploader has left the session.
      </Modal>

      <Modal
        open={confirmLeave}
        onClose={() => setConfirmLeave(false)}
        title="Leave the session?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmLeave(false)}>
              Cancel
            </Button>
            <Button
              variant="secondary"
              onClick={async () => {
                setConfirmLeave(false);
                await performLeave();
              }}
            >
              Keep files & leave
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                setConfirmLeave(false);
                await s.deleteOwnUploads();
                await performLeave();
              }}
            >
              Delete my files & leave
            </Button>
          </>
        }
      >
        You have {ownUploadCount} file{ownUploadCount === 1 ? '' : 's'} in the shared bucket. If you keep
        them, they’ll stay for the others until the owner removes them.
      </Modal>
    </div>
  );
}
