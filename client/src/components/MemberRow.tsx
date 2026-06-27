import {
  RiMore2Fill,
  RiSendPlane2Line,
  RiForbidLine,
  RiCloseCircleLine,
} from "react-icons/ri";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Badge } from "./ui/Badge";
import { PresenceDot } from "./ui/PresenceDot";
import { Button } from "./ui/Button";
import { Tooltip } from "./ui/Tooltip";
import type { PublicMember } from "../lib/api";
import { shortId } from "../lib/format";
import "./MemberRow.scss";

interface MemberRowProps {
  member: PublicMember;
  isYou: boolean;
  viewerIsOwner: boolean;
  // Whether the viewer has personally restricted this member (P2P, viewer-local).
  restricted?: boolean;
  // Whether the viewer themselves has been blocked by the owner (can't send).
  viewerBlocked?: boolean;
  // Whether sending is locked for the viewer because the session is read-only
  // and they're not the owner.
  sendLocked?: boolean;
  onSend: (member: PublicMember) => void;
  onKick: (member: PublicMember) => void;
  onMakeOwner: (member: PublicMember) => void;
  onDeleteUploads: (member: PublicMember) => void;
  onRestrict: (member: PublicMember, restrict: boolean) => void;
  onReport: (member: PublicMember) => void;
  onBlock: (member: PublicMember, blocked: boolean) => void;
  // While the session is frozen, only moderation actions stay available.
  frozen?: boolean;
}

export function MemberRow({
  member,
  isYou,
  viewerIsOwner,
  restricted = false,
  viewerBlocked = false,
  sendLocked = false,
  onSend,
  onKick,
  onMakeOwner,
  onDeleteUploads,
  onRestrict,
  onReport,
  onBlock,
  frozen = false,
}: MemberRowProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  // The menu is portaled to <body> so a scrollable roster can't clip it; we
  // anchor it to the trigger with a fixed position computed on open.
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(
    null
  );
  const menuWrapRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const canSend = !isYou && member.online;
  // Every member can restrict/report another; only the owner gets the
  // owner-only items. The owner themselves can't be restricted/reported/blocked
  // or otherwise managed, so their row has no menu at all.
  const showMenu = !isYou && !member.is_owner;

  function toggleMenu() {
    setMenuOpen((open) => {
      if (!open && menuWrapRef.current) {
        const r = menuWrapRef.current.getBoundingClientRect();
        setMenuPos({ top: r.bottom + 4, right: window.innerWidth - r.right });
      }
      return !open;
    });
  }

  useEffect(() => {
    if (!menuOpen) return;
    function onDocClick(e: MouseEvent) {
      const t = e.target as Node;
      if (!menuWrapRef.current?.contains(t) && !menuRef.current?.contains(t)) {
        setMenuOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    // The fixed menu can't follow the trigger while scrolling/resizing, so
    // dismiss it instead of letting it drift away from the row.
    function onReposition() {
      setMenuOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onReposition, true);
    window.addEventListener("resize", onReposition);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onReposition, true);
      window.removeEventListener("resize", onReposition);
    };
  }, [menuOpen]);

  // Count moderation badges to determine responsive display
  const moderationBadgeCount =
    (member.blocked ? 1 : 0) + (!isYou && restricted ? 1 : 0);

  return (
    <li className="member_row">
      <PresenceDot online={member.online} />
      <div className="member_row_identity">
        <span className="member_row_name">{member.display_name}</span>
        <span className="member_row_tag">({shortId(member.user_id)})</span>
      </div>
      <div
        className="member_row_badges"
        data-badge-count={moderationBadgeCount}
      >
        {isYou && <Badge variant="accent">you</Badge>}
        {member.is_owner && <Badge variant="success">owner</Badge>}
        {member.blocked && (
          <Tooltip label="Blocked" placement="top">
            <div className="member_row_badge_item">
              <Badge variant="danger">blocked</Badge>
              <div className="member_row_badge_icon">
                <RiForbidLine size={16} />
              </div>
            </div>
          </Tooltip>
        )}
        {!isYou && restricted && (
          <Tooltip label="Restricted" placement="top">
            <div className="member_row_badge_item">
              <Badge variant="warn">restricted</Badge>
              <div className="member_row_badge_icon">
                <RiCloseCircleLine size={16} />
              </div>
            </div>
          </Tooltip>
        )}
      </div>
      {!isYou && (
        <div className="member_row_actions">
          {/* Sending is hidden (not just disabled) while the session is frozen,
              when the owner has blocked the viewer, or in a read-only session
              where the viewer isn't the owner. */}
          {!(frozen || viewerBlocked || sendLocked) && (
            <Button
              size="sm"
              variant="ghost"
              icon={<RiSendPlane2Line size={16} />}
              disabled={!canSend}
              onClick={() => onSend(member)}
              aria-label={`Send file to ${member.display_name}`}
            >
              Send
            </Button>
          )}
          {showMenu && (
            <div className="member_row_menu_wrap" ref={menuWrapRef}>
              <Tooltip label="Member actions" placement="top">
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<RiMore2Fill size={16} />}
                  aria-label="Member actions"
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  onClick={toggleMenu}
                />
              </Tooltip>
              {menuOpen &&
                menuPos &&
                createPortal(
                  <div
                    ref={menuRef}
                    className="member_row_menu"
                    role="menu"
                    style={{ top: menuPos.top, right: menuPos.right }}
                  >
                    <button
                      className="member_row_menu_item"
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false);
                        onRestrict(member, !restricted);
                      }}
                    >
                      {restricted ? "Unrestrict" : "Restrict"}
                    </button>
                    {/* Reports exist for the owner to review; the owner has
                        Block/Kick directly, so reporting to themselves is moot. */}
                    {!viewerIsOwner && (
                      <button
                        className="member_row_menu_item"
                        role="menuitem"
                        onClick={() => {
                          setMenuOpen(false);
                          onReport(member);
                        }}
                      >
                        Report
                      </button>
                    )}
                    {viewerIsOwner && (
                      <>
                        <div className="member_row_menu_sep" role="separator" />
                        <button
                          className="member_row_menu_item"
                          role="menuitem"
                          onClick={() => {
                            setMenuOpen(false);
                            onBlock(member, !member.blocked);
                          }}
                        >
                          {member.blocked ? "Unblock" : "Block"}
                        </button>
                        <button
                          className="member_row_menu_item"
                          role="menuitem"
                          disabled={frozen || member.blocked}
                          onClick={() => {
                            setMenuOpen(false);
                            onMakeOwner(member);
                          }}
                        >
                          Make owner
                        </button>
                        <button
                          className="member_row_menu_item"
                          role="menuitem"
                          disabled={frozen}
                          onClick={() => {
                            setMenuOpen(false);
                            onDeleteUploads(member);
                          }}
                        >
                          Delete all uploads
                        </button>
                        <button
                          className="member_row_menu_item member_row_menu_danger"
                          role="menuitem"
                          onClick={() => {
                            setMenuOpen(false);
                            onKick(member);
                          }}
                        >
                          Kick
                        </button>
                      </>
                    )}
                  </div>,
                  document.body
                )}
            </div>
          )}
        </div>
      )}
    </li>
  );
}
