import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  RiFileCopyLine,
  RiShareForwardLine,
  RiUserAddLine,
  RiMore2Fill,
  RiLogoutBoxRLine,
  RiFolder3Line,
  RiFile2Line,
  RiGroupLine,
  RiArrowLeftRightLine,
  RiLockLine,
  RiLockUnlockLine,
  RiDeleteBin6Line,
  RiDownloadLine,
  RiEyeLine,
  RiEyeOffLine,
  RiWifiOffLine,
  RiErrorWarningLine,
  RiStopCircleLine,
  RiPlayCircleLine,
  RiShieldFlashLine,
} from "react-icons/ri";
import { useSession } from "../lib/use_session";
import { useToast } from "../components/ui/Toast";
import { Page } from "../components/ui/Page";
import { Panel } from "../components/ui/Panel";
import { Popover } from "../components/ui/Popover";
import { Tabs } from "../components/ui/Tabs";
import { StateScreen } from "../components/ui/StateScreen";
import { Button } from "../components/ui/Button";
import { Badge } from "../components/ui/Badge";
import { Input } from "../components/ui/Input";
import { Modal } from "../components/ui/Modal";
import { Skeleton } from "../components/ui/Skeleton";
import { MemberRow } from "../components/MemberRow";
import { FileRow } from "../components/FileRow";
import { UploadDropzone } from "../components/UploadDropzone";
import { KnockQueueModal } from "../components/KnockQueueModal";
import { InviteModal } from "../components/InviteModal";
import { SendFileModal } from "../components/SendFileModal";
import { IncomingTransferModal } from "../components/IncomingTransferModal";
import { TransferProgressRow } from "../components/TransferProgressRow";
import { sessionStore } from "../lib/sessionStore";
import { normalizeSlug } from "../lib/slug";
import type { PublicMember } from "../lib/api";
import { shortId, formatBytes } from "../lib/format";
import "./Session.scss";

type SessionTab = "files" | "people" | "activity";

export function Session() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { slug = "" } = useParams();
  const cleanSlug = normalizeSlug(slug);
  const s = useSession(cleanSlug);
  const [sendTarget, setSendTarget] = useState<PublicMember | null>(null);
  const [kickTarget, setKickTarget] = useState<PublicMember | null>(null);
  const [makeOwnerTarget, setMakeOwnerTarget] = useState<PublicMember | null>(
    null
  );
  const [deleteUploadsTarget, setDeleteUploadsTarget] =
    useState<PublicMember | null>(null);
  const [confirmOrphaned, setConfirmOrphaned] = useState(false);
  const [confirmDeleteSelected, setConfirmDeleteSelected] = useState(false);
  const [confirmDownload, setConfirmDownload] = useState(false);
  const [zipName, setZipName] = useState("");
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [hideMine, setHideMine] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [confirmOwnerLeave, setConfirmOwnerLeave] = useState(false);
  const [ownerTransferPick, setOwnerTransferPick] = useState(false);
  const [knockOpen, setKnockOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [tab, setTab] = useState<SessionTab>("files");

  const memberIds = new Set(s.members.map((m) => m.user_id));
  const orphanedCount = s.bucket.filter(
    (e) => !memberIds.has(e.uploader_id)
  ).length;
  const ownUploadCount = s.bucket.filter(
    (e) => e.uploader_id === s.yourUserId
  ).length;
  const otherMembers = s.members.filter((m) => m.user_id !== s.yourUserId);

  // Optionally hide your own uploads to focus on what others have shared.
  const visibleBucket = hideMine
    ? s.bucket.filter((e) => e.uploader_id !== s.yourUserId)
    : s.bucket;

  // Bucket multi-select (download for everyone; bulk delete is owner-only since
  // selected files may belong to different uploaders). Selection and select-all
  // operate on the currently visible files.
  const bucketIds = visibleBucket.map((e) => e.id);
  const selectedEntries = visibleBucket.filter((e) => selectedFiles.has(e.id));
  const selectedCount = selectedEntries.length;
  const allSelected =
    bucketIds.length > 0 && bucketIds.every((id) => selectedFiles.has(id));

  // Drop selections for files that have been removed (deleted, kicked uploader).
  useEffect(() => {
    setSelectedFiles((prev) => {
      if (prev.size === 0) return prev;
      const ids = new Set(s.bucket.map((e) => e.id));
      const next = new Set<string>();
      for (const id of prev) if (ids.has(id)) next.add(id);
      return next.size === prev.size ? prev : next;
    });
  }, [s.bucket]);

  function toggleFile(id: string) {
    setSelectedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleAllFiles() {
    setSelectedFiles(allSelected ? new Set() : new Set(bucketIds));
  }
  function toggleHideMine() {
    setHideMine((v) => !v);
    setSelectedFiles(new Set());
  }

  // Tick once a second only while an owner-disconnect countdown is active, so
  // the banner's M:SS display stays current without re-rendering otherwise.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (s.ownerGraceEndsAt == null) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [s.ownerGraceEndsAt]);

  // Warn before leaving with active work.
  useEffect(() => {
    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (s.hasActiveWork) {
        e.preventDefault();
        e.returnValue = "";
      }
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [s.hasActiveWork]);

  const [inviteOpen, setInviteOpen] = useState(false);

  async function copySlug() {
    try {
      await navigator.clipboard.writeText(cleanSlug);
      toast("Session ID copied.", "success");
    } catch {
      toast(cleanSlug, "info");
    }
  }

  async function performLeave() {
    await s.leave();
    sessionStore.reset();
    navigate("/");
  }

  async function onLeave() {
    // The owner leaving ends the session for everyone, so offer to hand it off
    // to another member or end it outright.
    if (s.isOwner) {
      setConfirmOwnerLeave(true);
      return;
    }
    // Non-owners always confirm before leaving; the dialog additionally asks
    // about their uploads when they have files in the bucket.
    setConfirmLeave(true);
  }

  if (s.status === "fatal") {
    return (
      <Page>
        <StateScreen
          tone="danger"
          icon={<RiErrorWarningLine size={30} />}
          title="Session unavailable"
          helper={s.fatalMessage}
          action={<Button onClick={() => navigate("/")}>Back to home</Button>}
        />
      </Page>
    );
  }

  if (s.status === "connecting") {
    return (
      <Page wide>
        <div className="session_loading">
          <Skeleton height={96} />
          <div className="session_loading_grid">
            <Skeleton height={280} />
            <Skeleton height={280} />
          </div>
        </div>
      </Page>
    );
  }

  const onlineCount = s.members.filter((m) => m.online).length;
  const filesEmpty = s.bucket.length === 0 && s.uploads.length === 0;

  // Owner-disconnect countdown: shown to remaining members while the owner is
  // offline. The server ends the session at this deadline, so the M:SS we show
  // reflects the real teardown moment.
  const ownerGraceRemainingMs =
    s.ownerGraceEndsAt != null ? Math.max(0, s.ownerGraceEndsAt - now) : null;
  const showOwnerGrace = ownerGraceRemainingMs != null && !s.isOwner;
  const ownerGraceClock = (() => {
    if (ownerGraceRemainingMs == null) return "0:00";
    const total = Math.ceil(ownerGraceRemainingMs / 1000);
    const m = Math.floor(total / 60);
    const sec = total % 60;
    return `${m}:${String(sec).padStart(2, "0")}`;
  })();

  const slugChip = (
    <button
      type="button"
      className="session_chip"
      onClick={copySlug}
      title="Copy session ID"
    >
      <span className="session_chip_hash">#</span>
      <span className="session_chip_text">{cleanSlug}</span>
      <RiFileCopyLine size={14} />
    </button>
  );

  const ownerBadge = s.isOwner ? <Badge variant="accent">owner</Badge> : null;

  const ownerMenu = s.isOwner ? (
    <Popover
      open={menuOpen}
      onClose={() => setMenuOpen(false)}
      label="Owner actions"
      trigger={
        <button
          type="button"
          className="session_iconbtn"
          aria-label="Owner actions"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((o) => !o)}
        >
          <RiMore2Fill size={18} />
        </button>
      }
    >
      <div className="session_menu" role="menu">
        <button
          type="button"
          role="menuitem"
          className="session_menu_item"
          disabled={s.frozen}
          title={
            s.frozen ? "Unfreeze the session to manage knocking" : undefined
          }
          onClick={() => {
            setMenuOpen(false);
            s.setPaused(!s.knockingPaused);
          }}
        >
          {s.knockingPaused ? (
            <RiLockUnlockLine size={16} />
          ) : (
            <RiLockLine size={16} />
          )}
          {s.knockingPaused ? "Resume knocking" : "Pause knocking"}
        </button>
        <button
          type="button"
          role="menuitem"
          className="session_menu_item session_menu_danger"
          disabled={orphanedCount === 0 || s.frozen}
          onClick={() => {
            setMenuOpen(false);
            setConfirmOrphaned(true);
          }}
        >
          <RiDeleteBin6Line size={16} />
          Delete orphaned
          {orphanedCount > 0 ? ` (${orphanedCount})` : ""}
        </button>
      </div>
    </Popover>
  ) : null;

  const bar = (
    <div className="session_bar_actions">
      {s.isOwner && (
        <button
          type="button"
          className="session_bell"
          aria-label={
            s.knockers.length > 0
              ? `Knock queue, ${s.knockers.length} waiting`
              : "Knock queue"
          }
          aria-haspopup="dialog"
          aria-expanded={knockOpen}
          onClick={() => setKnockOpen(true)}
        >
          <RiUserAddLine size={18} />
          {s.knockers.length > 0 && (
            <span className="session_bell_badge">{s.knockers.length}</span>
          )}
        </button>
      )}

      {s.isOwner && (
        <Button
          size="sm"
          variant={s.frozen ? "secondary" : "danger"}
          className="session_action_freeze"
          icon={
            s.frozen ? (
              <RiPlayCircleLine size={16} />
            ) : (
              <RiStopCircleLine size={16} />
            )
          }
          aria-label={s.frozen ? "Resume activity" : "Halt all activity"}
          title={s.frozen ? "Resume activity" : "Halt all activity"}
          onClick={() => s.setFrozen(!s.frozen)}
        >
          {s.frozen ? "Resume" : "Halt activity"}
        </Button>
      )}

      <Button
        size="sm"
        variant="danger"
        icon={<RiLogoutBoxRLine size={16} />}
        onClick={onLeave}
      >
        Leave
      </Button>
    </div>
  );

  return (
    <Page wide bar={bar}>
      <div className="session">
        {s.reconnecting && (
          <div
            className="session_reconnecting"
            role="status"
            aria-live="polite"
          >
            <RiWifiOffLine size={16} />
            Connection lost — reconnecting…
          </div>
        )}

        {showOwnerGrace && (
          <div
            className="session_owner_offline_banner"
            role="status"
            aria-live="polite"
          >
            <RiWifiOffLine size={16} />
            Owner disconnected — session ends in {ownerGraceClock} unless they
            return.
          </div>
        )}

        {s.frozen && (
          <div
            className="session_frozen_banner"
            role="status"
            aria-live="polite"
          >
            <RiShieldFlashLine size={16} />
            {s.isOwner
              ? "Session frozen — read-only for everyone until you resume."
              : "Session frozen by the owner — read-only until resumed."}
          </div>
        )}

        <div className="session_meta">
          {slugChip}
          {s.isOwner && (
            <Button
              size="sm"
              className="session_meta_invite"
              icon={<RiShareForwardLine size={16} />}
              onClick={() => setInviteOpen(true)}
            >
              Invite
            </Button>
          )}
          {s.isOwner && (
            <div className="session_meta_right">
              {ownerBadge}
              {ownerMenu}
            </div>
          )}
        </div>

        <Tabs
          className="session_tabs"
          ariaLabel="Session sections"
          value={tab}
          onChange={(id) => setTab(id as SessionTab)}
          items={[
            {
              id: "files",
              label: "Files",
              badge: s.bucket.length || undefined,
            },
            { id: "people", label: "People", badge: s.members.length },
            {
              id: "activity",
              label: "Activity",
              badge: s.transfers.length || undefined,
            },
          ]}
        />

        <div className="session_panes" data-tab={tab}>
          <Panel
            className="session_pane session_pane_files"
            title="Shared bucket"
            icon={<RiFolder3Line size={20} />}
            count={s.bucket.length}
            actions={
              s.encryptionActive ? (
                <span
                  className="session_encrypted"
                  title="End-to-end encrypted"
                >
                  <RiLockLine size={18} />
                  <span className="session_encrypted_label">
                    End-to-end encrypted
                  </span>
                </span>
              ) : undefined
            }
          >
            <UploadDropzone
              onFiles={s.uploadFiles}
              disabled={s.frozen}
              encrypted={s.encryptionActive}
            />

            {filesEmpty ? (
              <div className="session_empty">
                <div className="session_empty_container">
                  <span className="session_empty_icon">
                    <RiFile2Line size={26} />
                  </span>
                  <p className="session_empty_title">No files yet</p>
                </div>

                <hr className="horizontal_divider subtle" />

                {s.isOwner ? (
                  <>
                    <p className="session_empty_help">
                      Share the invite to bring people in, then drop files to
                      share with everyone.
                    </p>
                  </>
                ) : (
                  <p className="session_empty_help">
                    Drop a file above to share it with everyone in the session.
                  </p>
                )}
              </div>
            ) : (
              <>
                {s.bucket.length > 0 && (
                  <div className="session_bucket_toolbar">
                    <label className="session_bucket_selectall">
                      <input
                        type="checkbox"
                        checked={allSelected}
                        onChange={toggleAllFiles}
                        aria-label="Select all files"
                        disabled={bucketIds.length === 0}
                      />
                      <span>
                        {selectedCount > 0
                          ? `${selectedCount} selected`
                          : `Select all (${bucketIds.length})`}
                      </span>
                    </label>
                    <div className="session_bucket_toolbar_actions">
                      {ownUploadCount > 0 && (
                        <Button
                          size="sm"
                          variant="ghost"
                          icon={
                            hideMine ? (
                              <RiEyeLine size={16} />
                            ) : (
                              <RiEyeOffLine size={16} />
                            )
                          }
                          aria-pressed={hideMine}
                          aria-label={
                            hideMine ? "Show my files" : "Hide my files"
                          }
                          onClick={toggleHideMine}
                        ></Button>
                      )}
                      {selectedCount > 0 && (
                        <>
                          <Button
                            size="sm"
                            variant="ghost"
                            icon={<RiDownloadLine size={16} />}
                            disabled={s.frozen}
                            aria-label="Download selected files"
                            onClick={() => {
                              setZipName(`handover-${cleanSlug}`);
                              setConfirmDownload(true);
                            }}
                          >
                            Download
                          </Button>
                          {s.isOwner && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="session_bucket_delete"
                              icon={<RiDeleteBin6Line size={16} />}
                              disabled={s.frozen}
                              aria-label="Delete selected files"
                              onClick={() => setConfirmDeleteSelected(true)}
                            >
                              Delete
                            </Button>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                )}
                {visibleBucket.length === 0 && s.uploads.length === 0 ? (
                  <p className="session_bucket_hint">
                    Your files are hidden. Choose “Show mine” to see them again.
                  </p>
                ) : (
                  <ul className="session_file_list">
                    {s.uploads.map((u) => (
                      <FileRow
                        key={u.tempId}
                        entry={u.entry}
                        uploaderName="you"
                        isYours
                        justAdded={false}
                        onDelete={() => undefined}
                        progress={u.fraction}
                        onCancelUpload={u.abort}
                      />
                    ))}
                    {visibleBucket.map((e) => (
                      <FileRow
                        key={e.id}
                        entry={e}
                        uploaderName={s.nameOf(e.uploader_id)}
                        isYours={e.uploader_id === s.yourUserId}
                        canDelete={e.uploader_id === s.yourUserId || s.isOwner}
                        justAdded={s.justAdded.has(e.id)}
                        onDownload={s.downloadFile}
                        onDelete={s.deleteFile}
                        frozen={s.frozen}
                        selectable
                        selected={selectedFiles.has(e.id)}
                        onToggleSelect={toggleFile}
                      />
                    ))}
                  </ul>
                )}
              </>
            )}
          </Panel>

          <div className="session_rail">
            <Panel
              className="session_pane session_pane_people"
              title="People"
              icon={<RiGroupLine size={20} />}
              count={s.members.length}
              actions={
                <span className="session_online">{onlineCount} online</span>
              }
            >
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
                    frozen={s.frozen}
                  />
                ))}
              </ul>
            </Panel>

            <Panel
              className="session_pane session_pane_activity"
              title="Activity"
              icon={<RiArrowLeftRightLine size={20} />}
              count={s.transfers.length || undefined}
            >
              {s.transfers.length === 0 ? (
                <p className="session_empty_text">No transfers yet.</p>
              ) : (
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
              )}
            </Panel>
          </div>
        </div>
      </div>

      {s.isOwner && (
        <KnockQueueModal
          open={knockOpen}
          onClose={() => setKnockOpen(false)}
          knockers={s.knockers}
          paused={s.knockingPaused}
          onAdmit={s.admit}
          onReject={s.reject}
        />
      )}

      {s.isOwner && (
        <InviteModal
          open={inviteOpen}
          onClose={() => setInviteOpen(false)}
          slug={cleanSlug}
          frozen={s.frozen}
          usedSignal={s.inviteUsed}
        />
      )}

      <SendFileModal
        recipient={sendTarget}
        onClose={() => setSendTarget(null)}
        onSend={(r, files) => {
          s.startSend(r, files);
          setSendTarget(null);
        }}
      />

      <IncomingTransferModal
        request={s.incoming}
        onAccept={s.acceptIncoming}
        onDecline={s.declineIncoming}
      />

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
        They’ll be removed immediately and their uploaded files will be deleted
        for everyone.
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
        {s.ownerOffer && (
          <>
            {s.nameOf(s.ownerOffer.from_user_id)} wants to transfer ownership to
            you.
          </>
        )}
      </Modal>

      <Modal
        open={!!deleteUploadsTarget}
        onClose={() => setDeleteUploadsTarget(null)}
        title={`Delete all of ${deleteUploadsTarget?.display_name}’s uploads?`}
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => setDeleteUploadsTarget(null)}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (deleteUploadsTarget)
                  s.deleteMemberFiles(deleteUploadsTarget.user_id);
                setDeleteUploadsTarget(null);
              }}
            >
              Delete files
            </Button>
          </>
        }
      >
        Every file this member uploaded will be removed from the bucket for
        everyone.
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
              Delete {orphanedCount} file{orphanedCount === 1 ? "" : "s"}
            </Button>
          </>
        }
      >
        This removes every file whose uploader has left the session.
      </Modal>

      <Modal
        open={confirmDownload}
        onClose={() => setConfirmDownload(false)}
        title={`Download ${selectedCount} file${selectedCount === 1 ? "" : "s"}?`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDownload(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              icon={<RiDownloadLine size={16} />}
              disabled={selectedCount === 0}
              onClick={() => {
                void s.downloadFilesZip(
                  selectedEntries,
                  selectedCount > 1 ? zipName : undefined
                );
                setConfirmDownload(false);
              }}
            >
              {selectedCount > 1 ? "Download zip" : "Download"}
            </Button>
          </>
        }
      >
        {selectedCount > 1 && (
          <>
            <p className="session_download_note">
              These files will be saved together as a single .zip archive.
            </p>
            <div className="session_download_name_field">
              <Input
                label="Archive name"
                value={zipName}
                onChange={(e) => setZipName(e.target.value)}
                placeholder={`handover-${cleanSlug}`}
                aria-label="Zip file name"
                autoComplete="off"
                spellCheck={false}
              />
              <span className="session_download_name_suffix">.zip</span>
            </div>
          </>
        )}
        <ul className="session_download_list">
          {selectedEntries.map((e) => (
            <li key={e.id} className="session_download_item">
              <span className="session_download_name" title={e.name}>
                {e.name}
              </span>
              <span className="session_download_size">
                {formatBytes(e.size)}
              </span>
            </li>
          ))}
        </ul>
      </Modal>

      <Modal
        open={confirmDeleteSelected}
        onClose={() => setConfirmDeleteSelected(false)}
        title={`Delete ${selectedCount} selected file${selectedCount === 1 ? "" : "s"}?`}
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => setConfirmDeleteSelected(false)}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                void s.deleteFiles([...selectedFiles]);
                setSelectedFiles(new Set());
                setConfirmDeleteSelected(false);
              }}
            >
              Delete {selectedCount} file{selectedCount === 1 ? "" : "s"}
            </Button>
          </>
        }
      >
        These files may belong to different members. They will be removed for
        everyone and cannot be recovered.
      </Modal>

      <Modal
        open={confirmLeave}
        onClose={() => setConfirmLeave(false)}
        title="Leave the session?"
        className={ownUploadCount > 0 ? "session_leave_modal" : undefined}
        stackFooter={ownUploadCount > 0}
        footer={
          ownUploadCount > 0 ? (
            <>
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
                disabled={s.frozen}
                title={
                  s.frozen
                    ? "Session is halted — files can't be deleted right now"
                    : undefined
                }
                onClick={async () => {
                  setConfirmLeave(false);
                  await s.deleteOwnUploads();
                  await performLeave();
                }}
              >
                Delete my files & leave
              </Button>
              <Button variant="ghost" onClick={() => setConfirmLeave(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={() => setConfirmLeave(false)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={async () => {
                  setConfirmLeave(false);
                  await performLeave();
                }}
              >
                Leave
              </Button>
            </>
          )
        }
      >
        {ownUploadCount > 0 ? (
          <>
            You have {ownUploadCount} file{ownUploadCount === 1 ? "" : "s"} in
            the shared bucket. If you keep them, they’ll stay for the others
            until the owner removes them.
            {s.frozen && (
              <>
                {" "}
                The session is halted, so deleting files is unavailable right
                now.
              </>
            )}
          </>
        ) : (
          <>
            You’ll be removed from the session and lose access to the shared
            bucket. You can rejoin later by knocking again.
          </>
        )}
      </Modal>

      <Modal
        open={confirmOwnerLeave}
        onClose={() => setConfirmOwnerLeave(false)}
        title="Leave the session?"
        className="session_owner_leave_modal"
        stackFooter
        footer={
          <>
            <Button
              variant="secondary"
              disabled={otherMembers.length === 0}
              onClick={() => {
                setConfirmOwnerLeave(false);
                setOwnerTransferPick(true);
              }}
            >
              Transfer ownership
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                setConfirmOwnerLeave(false);
                await performLeave();
              }}
            >
              End session
            </Button>
            <Button variant="ghost" onClick={() => setConfirmOwnerLeave(false)}>
              Cancel
            </Button>
          </>
        }
      >
        You’re the owner. Hand the session to another member to keep it running,
        or end it for everyone.
        {otherMembers.length === 0 &&
          " There’s no one else here yet, so it can only be ended."}
      </Modal>

      <Modal
        open={ownerTransferPick}
        onClose={() => setOwnerTransferPick(false)}
        title="Transfer ownership to…"
        showClose
      >
        <ul className="session_transfer_list">
          {otherMembers.map((m) => (
            <li key={m.user_id}>
              <button
                type="button"
                className="session_transfer_pick"
                onClick={() => {
                  s.makeOwner(m.user_id);
                  setOwnerTransferPick(false);
                  toast(
                    `Ownership offer sent to ${m.display_name}. They’ll take over once they accept.`,
                    "info"
                  );
                }}
              >
                <span className="session_transfer_pick_name">
                  {m.display_name}
                </span>
                <span className="session_transfer_pick_id">
                  #{shortId(m.user_id)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </Modal>
    </Page>
  );
}
