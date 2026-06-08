import { RiCheckLine, RiCloseLine } from "react-icons/ri";
import { Button } from "./ui/Button";
import { relativeTime } from "../lib/format";
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
}: {
  knock: Knock;
  onAdmit: (id: string) => void;
  onReject: (id: string) => void;
}) {
  return (
    <li className="knock_queue_item">
      <div className="knock_queue_item_info">
        <span className="knock_queue_item_name">{knock.display_name}</span>
        <span className="knock_queue_item_time">
          knocked {relativeTime(knock.created_at)}
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
