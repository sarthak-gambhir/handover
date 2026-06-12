import { RiCheckLine, RiCloseLine } from "react-icons/ri";
import { Button } from "./ui/Button";
import { relativeTime, shortId } from "../lib/format";
import { cx } from "../lib/cx";
import "./KnockQueueItem.scss";

export interface Knock {
  knock_id: string;
  display_name: string;
  created_at: number;
}

export function KnockQueueItem({
  knock,
  onAdmit,
  onReject,
  selectable = false,
  selected = false,
  onToggleSelect,
}: {
  knock: Knock;
  onAdmit: (id: string) => void;
  onReject: (id: string) => void;
  selectable?: boolean;
  selected?: boolean;
  onToggleSelect?: (id: string) => void;
}) {
  return (
    <li
      className={cx(
        "knock_queue_item",
        selected && "knock_queue_item_selected"
      )}
    >
      {selectable && (
        <input
          type="checkbox"
          className="knock_queue_item_check"
          checked={selected}
          onChange={() => onToggleSelect?.(knock.knock_id)}
          aria-label={`Select ${knock.display_name}`}
        />
      )}
      <div
        className="knock_queue_item_info"
        onClick={
          selectable ? () => onToggleSelect?.(knock.knock_id) : undefined
        }
      >
        <span className="knock_queue_item_name">{knock.display_name}</span>
        <span className="knock_queue_item_time">
          knocked {relativeTime(knock.created_at)} ·{" "}
          <span className="knock_queue_item_id">
            #{shortId(knock.knock_id)}
          </span>
        </span>
      </div>
      <div className="knock_queue_item_actions">
        <Button
          size="sm"
          variant="primary"
          icon={<RiCheckLine size={16} />}
          onClick={() => onAdmit(knock.knock_id)}
        >
          Admit
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon={<RiCloseLine size={16} />}
          onClick={() => onReject(knock.knock_id)}
          aria-label="Reject"
        >
          Reject
        </Button>
      </div>
    </li>
  );
}
