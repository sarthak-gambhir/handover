import { useCallback, useEffect, useState } from "react";
import {
  RiAddLine,
  RiDeleteBinLine,
  RiFileCopyLine,
  RiMailSendLine,
} from "react-icons/ri";
import { Modal } from "./ui/Modal";
import { Button } from "./ui/Button";
import { Badge } from "./ui/Badge";
import { EmptyState } from "./ui/EmptyState";
import { useToast } from "./ui/Toast";
import { api, ApiError, type InviteSummary } from "../lib/api";
import { invitePath } from "../lib/slug";
import { expiresIn } from "../lib/format";
import "./InviteModal.scss";

interface InviteModalProps {
  open: boolean;
  onClose: () => void;
  slug: string;
  frozen: boolean;
  // Bumped whenever the owner is told an invite was redeemed, so the open list
  // can drop the consumed code without a manual refresh.
  usedSignal?: { code: string; at: number } | null;
}

export function InviteModal({
  open,
  onClose,
  slug,
  frozen,
  usedSignal,
}: InviteModalProps) {
  const { toast } = useToast();
  const [invites, setInvites] = useState<InviteSummary[]>([]);
  const [cap, setCap] = useState(0);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [busyCode, setBusyCode] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.listInvites(slug);
      setInvites(res.invites);
      setCap(res.cap);
    } catch {
      toast("Could not load invite links.", "danger");
    } finally {
      setLoading(false);
    }
  }, [slug, toast]);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  // Drop a consumed invite from the open list as soon as the owner is notified.
  useEffect(() => {
    if (!usedSignal) return;
    setInvites((prev) => prev.filter((i) => i.code !== usedSignal.code));
  }, [usedSignal]);

  function linkFor(code: string): string {
    return `${window.location.origin}${invitePath(slug, code)}`;
  }

  async function copyLink(code: string) {
    const url = linkFor(code);
    try {
      await navigator.clipboard.writeText(url);
      toast("Invite link copied.", "success");
    } catch {
      toast(url, "info");
    }
  }

  async function onCreate() {
    if (creating) return;
    setCreating(true);
    try {
      const { code } = await api.createInvite(slug);
      await copyLink(code);
      await refresh();
    } catch (err) {
      const apiCode = err instanceof ApiError ? err.code : "error";
      if (apiCode === "invite_cap")
        toast("Invite limit reached — revoke one to create more.", "warn");
      else if (apiCode === "session_frozen")
        toast("Session is halted — resume it to invite people.", "warn");
      else if (apiCode === "rate_limited")
        toast("Too many invites. Wait a moment.", "warn");
      else toast("Could not create an invite link.", "danger");
    } finally {
      setCreating(false);
    }
  }

  async function onRevoke(code: string) {
    setBusyCode(code);
    try {
      await api.revokeInvite(slug, code);
      setInvites((prev) => prev.filter((i) => i.code !== code));
    } catch {
      toast("Could not revoke that invite.", "danger");
    } finally {
      setBusyCode(null);
    }
  }

  const atCap = cap > 0 && invites.length >= cap;

  const footer = (
    <>
      {cap > 0 && (
        <span className="invite_modal_count">
          <Badge variant={atCap ? "warn" : "neutral"}>
            {invites.length} / {cap} active
          </Badge>
        </span>
      )}
      <Button
        variant="primary"
        icon={<RiAddLine size={16} />}
        onClick={onCreate}
        loading={creating}
        disabled={frozen || atCap}
      >
        Create invite link
      </Button>
    </>
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      className="invite_modal"
      showClose
      title="Invite links"
      footer={footer}
    >
      <div className="invite_modal_body">
        <p className="invite_modal_hint">
          Each link admits one person with no knock and expires after 30 minutes.
        </p>
        {frozen && (
          <p className="invite_modal_warn">
            Session is halted — resume it to create new links.
          </p>
        )}

        <div className="invite_modal_scroll">
          {loading && invites.length === 0 ? (
            <p className="invite_modal_loading">Loading…</p>
          ) : invites.length === 0 ? (
            <EmptyState
              icon={<RiMailSendLine size={32} />}
              title="No active invites"
              helper="Create a link to invite someone directly, no knock required."
            />
          ) : (
            <ul className="invite_modal_list">
              {invites.map((inv) => (
                <li key={inv.code} className="invite_modal_item">
                  <div className="invite_modal_item_info">
                    <span className="invite_modal_code">#{inv.code.slice(-6)}</span>
                    <span className="invite_modal_exp">{expiresIn(inv.expires_at)}</span>
                  </div>
                  <div className="invite_modal_item_actions">
                    <Button
                      size="sm"
                      variant="secondary"
                      icon={<RiFileCopyLine size={16} />}
                      onClick={() => copyLink(inv.code)}
                    >
                      Copy link
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<RiDeleteBinLine size={16} />}
                      onClick={() => onRevoke(inv.code)}
                      loading={busyCode === inv.code}
                      aria-label="Revoke invite"
                    >
                      Revoke
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Modal>
  );
}
