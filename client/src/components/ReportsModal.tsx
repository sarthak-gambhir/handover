import { RiFlagLine, RiShieldCheckLine } from "react-icons/ri";
import { Modal } from "./ui/Modal";
import { Button } from "./ui/Button";
import { Badge } from "./ui/Badge";
import { EmptyState } from "./ui/EmptyState";
import type { PublicReport } from "../lib/api";
import { relativeTime } from "../lib/format";
import "./ReportsModal.scss";

interface ReportsModalProps {
  open: boolean;
  onClose: () => void;
  reports: PublicReport[];
  // Members still present in the session, keyed by user_id, with their blocked
  // status. Used to gate Block/Kick (a reported member may have already left).
  blockedIds: Set<string>;
  presentIds: Set<string>;
  onBlock: (user_id: string, blocked: boolean) => void;
  onKick: (report: PublicReport) => void;
  onIgnore: (user_id: string) => void;
}

export function ReportsModal({
  open,
  onClose,
  reports,
  blockedIds,
  presentIds,
  onBlock,
  onKick,
  onIgnore,
}: ReportsModalProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      className="reports_modal"
      showClose
      title={
        <span className="reports_modal_title">
          Reported members
          {reports.length > 0 && (
            <Badge variant="danger">{reports.length}</Badge>
          )}
        </span>
      }
    >
      <div className="reports_modal_body">
        {reports.length === 0 ? (
          <EmptyState
            icon={<RiShieldCheckLine size={32} />}
            title="Nothing reported"
            helper="Members flagged by others will show up here for review."
          />
        ) : (
          <ul className="reports_modal_list">
            {reports.map((r) => {
              const present = presentIds.has(r.user_id);
              const blocked = blockedIds.has(r.user_id);
              return (
                <li key={r.user_id} className="reports_modal_item">
                  <div className="reports_modal_head">
                    <span className="reports_modal_name">
                      <RiFlagLine size={14} />
                      {r.display_name}
                    </span>
                    <Badge variant="warn">
                      {r.count} report{r.count === 1 ? "" : "s"}
                    </Badge>
                    {blocked && <Badge variant="danger">blocked</Badge>}
                    {!present && <Badge variant="neutral">left</Badge>}
                  </div>
                  {r.reporters.some((rp) => rp.reason) && (
                    <ul className="reports_modal_reasons">
                      {r.reporters
                        .filter((rp) => rp.reason)
                        .map((rp, i) => (
                          <li key={i} className="reports_modal_reason">
                            <span className="reports_modal_reason_text">
                              “{rp.reason}”
                            </span>
                            <span className="reports_modal_reason_meta">
                              {rp.display_name} · {relativeTime(rp.at)}
                            </span>
                          </li>
                        ))}
                    </ul>
                  )}
                  <div className="reports_modal_actions">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => onIgnore(r.user_id)}
                    >
                      Ignore
                    </Button>
                    {present && (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => onBlock(r.user_id, !blocked)}
                      >
                        {blocked ? "Unblock" : "Block"}
                      </Button>
                    )}
                    {present && (
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() => onKick(r)}
                      >
                        Kick
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Modal>
  );
}
