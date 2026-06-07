import { FaEllipsisVertical, FaPaperPlane } from 'react-icons/fa6';
import { useState } from 'react';
import { Badge } from './ui/Badge';
import { PresenceDot } from './ui/PresenceDot';
import { Button } from './ui/Button';
import type { PublicMember } from '../lib/api';
import { shortId } from '../lib/format';
import { cx } from '../lib/cx';
import './MemberRow.scss';

interface MemberRowProps {
  member: PublicMember;
  isYou: boolean;
  viewerIsOwner: boolean;
  onSend: (member: PublicMember) => void;
  onKick: (member: PublicMember) => void;
  onMakeOwner: (member: PublicMember) => void;
}

export function MemberRow({
  member,
  isYou,
  viewerIsOwner,
  onSend,
  onKick,
  onMakeOwner,
}: MemberRowProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const canSend = !isYou && member.online;
  const canManage = viewerIsOwner && !isYou;

  return (
    <li className="member_row">
      <PresenceDot online={member.online} />
      <div className="member_row_identity">
        <span className="member_row_name">{member.display_name}</span>
        {!isYou && <span className="member_row_tag">· {shortId(member.user_id)}</span>}
      </div>
      <div className="member_row_badges">
        {isYou && <Badge variant="accent">you</Badge>}
        {member.is_owner && <Badge variant="neutral">owner</Badge>}
      </div>
      <div className="member_row_actions">
        {!isYou && (
          <Button
            size="sm"
            variant="ghost"
            icon={<FaPaperPlane size={16} />}
            disabled={!canSend}
            onClick={() => onSend(member)}
            aria-label={`Send file to ${member.display_name}`}
          >
            Send
          </Button>
        )}
        {canManage && (
          <div className="member_row_menu_wrap">
            <Button
              size="sm"
              variant="ghost"
              icon={<FaEllipsisVertical size={16} />}
              aria-label="Member actions"
              onClick={() => setMenuOpen((v) => !v)}
            />
            {menuOpen && (
              <div className={cx('member_row_menu')}>
                <button
                  className="member_row_menu_item"
                  onClick={() => {
                    setMenuOpen(false);
                    onMakeOwner(member);
                  }}
                >
                  Make owner
                </button>
                <button
                  className="member_row_menu_item member_row_menu_danger"
                  onClick={() => {
                    setMenuOpen(false);
                    onKick(member);
                  }}
                >
                  Kick
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </li>
  );
}
