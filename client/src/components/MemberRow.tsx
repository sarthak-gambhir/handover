import { RiMore2Fill, RiSendPlane2Line } from "react-icons/ri";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Badge } from "./ui/Badge";
import { PresenceDot } from "./ui/PresenceDot";
import { Button } from "./ui/Button";
import type { PublicMember } from "../lib/api";
import { shortId } from "../lib/format";
import "./MemberRow.scss";

interface MemberRowProps {
  member: PublicMember;
  isYou: boolean;
  viewerIsOwner: boolean;
  onSend: (member: PublicMember) => void;
  onKick: (member: PublicMember) => void;
  onMakeOwner: (member: PublicMember) => void;
  onDeleteUploads: (member: PublicMember) => void;
  // While the session is frozen, only Kick stays available.
  frozen?: boolean;
}

export function MemberRow({
  member,
  isYou,
  viewerIsOwner,
  onSend,
  onKick,
  onMakeOwner,
  onDeleteUploads,
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
  const canManage = viewerIsOwner && !isYou;

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

  return (
    <li className="member_row">
      <PresenceDot online={member.online} />
      <div className="member_row_identity">
        <span className="member_row_name">{member.display_name}</span>
        {!isYou && (
          <span className="member_row_tag">· {shortId(member.user_id)}</span>
        )}
      </div>
      <div className="member_row_badges">
        {isYou && <Badge variant="accent">you</Badge>}
        {member.is_owner && <Badge variant="neutral">owner</Badge>}
      </div>
      {!isYou && (
        <div className="member_row_actions">
          <Button
            size="sm"
            variant="ghost"
            icon={<RiSendPlane2Line size={16} />}
            disabled={!canSend || frozen}
            onClick={() => onSend(member)}
            aria-label={`Send file to ${member.display_name}`}
          >
            Send
          </Button>
          {canManage && (
            <div className="member_row_menu_wrap" ref={menuWrapRef}>
              <Button
                size="sm"
                variant="ghost"
                icon={<RiMore2Fill size={16} />}
                aria-label="Member actions"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={toggleMenu}
              />
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
                      disabled={frozen}
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
