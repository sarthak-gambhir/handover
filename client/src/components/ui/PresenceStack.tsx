import { Avatar } from "./Avatar";
import "./PresenceStack.scss";

interface PresenceMember {
  user_id: string;
  display_name: string;
  online: boolean;
}

interface PresenceStackProps {
  members: PresenceMember[];
  max?: number;
  // Show a textual "n/m online" summary next to the stack.
  showCount?: boolean;
}

export function PresenceStack({
  members,
  max = 4,
  showCount = true,
}: PresenceStackProps) {
  const onlineCount = members.filter((m) => m.online).length;
  // Online members come first so the visible faces favour who's here now.
  const ordered = [...members].sort(
    (a, b) => Number(b.online) - Number(a.online),
  );
  const shown = ordered.slice(0, max);
  const overflow = members.length - shown.length;

  return (
    <div className="presence_stack">
      <div className="presence_stack_faces">
        {shown.map((m) => (
          <Avatar
            key={m.user_id}
            name={m.display_name}
            size="sm"
            online={m.online}
            className="presence_stack_face"
          />
        ))}
        {overflow > 0 && (
          <span className="presence_stack_overflow" title={`${overflow} more`}>
            +{overflow}
          </span>
        )}
      </div>
      {showCount && (
        <span className="presence_stack_count">
          {onlineCount}/{members.length} online
        </span>
      )}
    </div>
  );
}
