import { useState } from "react";
import {
  RiUploadLine,
  RiDownloadLine,
  RiDeleteBin6Line,
  RiArrowLeftRightLine,
  RiUserAddLine,
  RiLogoutBoxRLine,
  RiUserUnfollowLine,
  RiForbidLine,
  RiCheckLine,
  RiCloseCircleLine,
  RiFlagLine,
  RiArrowDownSLine,
} from "react-icons/ri";
import type { ReactNode } from "react";
import type { ActivityEntry, ActivityType } from "../lib/api";
import { relativeTime, formatBytes } from "../lib/format";
import { cx } from "../lib/cx";
import "./ActivityRow.scss";

const ICONS: Record<ActivityType, ReactNode> = {
  upload: <RiUploadLine size={16} />,
  download: <RiDownloadLine size={16} />,
  delete: <RiDeleteBin6Line size={16} />,
  transfer: <RiArrowLeftRightLine size={16} />,
  join: <RiUserAddLine size={16} />,
  leave: <RiLogoutBoxRLine size={16} />,
  kick: <RiUserUnfollowLine size={16} />,
  block: <RiForbidLine size={16} />,
  unblock: <RiCheckLine size={16} />,
  restrict: <RiCloseCircleLine size={16} />,
  unrestrict: <RiCheckLine size={16} />,
  report: <RiFlagLine size={16} />,
};

const OUTCOME_LABEL: Record<string, string> = {
  complete: "completed",
  declined: "declined",
  cancelled: "cancelled",
  failed: "failed",
};

function fileLabel(entry: ActivityEntry): string {
  if (entry.files && entry.files.length === 1) return entry.files[0].name;
  if (entry.files && entry.files.length > 1)
    return `${entry.files.length} files`;
  if (entry.count !== undefined)
    return `${entry.count} file${entry.count === 1 ? "" : "s"}`;
  return "";
}

// One-line summary describing who did what. The actor/target names are rendered
// emphasized; everything else is plain connective text.
function summary(entry: ActivityEntry): ReactNode {
  const actor = <strong>{entry.actor_name}</strong>;
  const target = <strong>{entry.target_name}</strong>;
  const label = fileLabel(entry);
  switch (entry.type) {
    case "upload":
      return <>{actor} uploaded {label}</>;
    case "download":
      return <>{actor} downloaded {label}</>;
    case "delete":
      return entry.target_name ? (
        <>{actor} deleted {label} from {target}</>
      ) : (
        <>{actor} deleted {label}</>
      );
    case "transfer":
      return (
        <>
          {actor} sent {label} to {target}
        </>
      );
    case "join":
      return <>{actor} joined</>;
    case "leave":
      return <>{actor} left</>;
    case "kick":
      return <>{actor} removed {target}</>;
    case "block":
      return <>{actor} blocked {target}</>;
    case "unblock":
      return <>{actor} unblocked {target}</>;
    case "restrict":
      return <>{actor} restricted {target}</>;
    case "unrestrict":
      return <>{actor} unrestricted {target}</>;
    case "report":
      return <>{actor} reported {target}</>;
    default:
      return actor;
  }
}

export function ActivityRow({ entry }: { entry: ActivityEntry }) {
  const [open, setOpen] = useState(false);
  const hasFiles = !!entry.files && entry.files.length > 0;
  const isTransfer = entry.type === "transfer";
  // Only file-bearing or transfer entries carry extra detail worth expanding.
  const expandable = hasFiles || isTransfer;

  return (
    <li className={cx("activity_row", `activity_row_${entry.type}`)}>
      <div
        className={cx("activity_row_head", expandable && "is_expandable")}
        role={expandable ? "button" : undefined}
        tabIndex={expandable ? 0 : undefined}
        aria-expanded={expandable ? open : undefined}
        onClick={expandable ? () => setOpen((o) => !o) : undefined}
        onKeyDown={
          expandable
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setOpen((o) => !o);
                }
              }
            : undefined
        }
      >
        <span className="activity_row_icon">{ICONS[entry.type]}</span>
        <span className="activity_row_summary">{summary(entry)}</span>
        {isTransfer && entry.outcome && (
          <span
            className={cx(
              "activity_row_outcome",
              `activity_row_outcome_${entry.outcome}`
            )}
          >
            {OUTCOME_LABEL[entry.outcome] ?? entry.outcome}
          </span>
        )}
        <span className="activity_row_time">{relativeTime(entry.at)}</span>
        {expandable && (
          <span className={cx("activity_row_chevron", open && "is_open")}>
            <RiArrowDownSLine size={16} />
          </span>
        )}
      </div>

      {expandable && open && (
        <div className="activity_row_detail">
          {hasFiles ? (
            <ul className="activity_row_files">
              {entry.files!.map((f, i) => (
                <li key={`${f.name}_${i}`} className="activity_row_file">
                  <span className="activity_row_file_name" title={f.name}>
                    {f.name}
                  </span>
                  <span className="activity_row_file_size">
                    {formatBytes(f.size)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="activity_row_detail_empty">No file details.</p>
          )}
          {entry.total_bytes !== undefined && entry.files && entry.files.length > 1 && (
            <p className="activity_row_total">
              Total {formatBytes(entry.total_bytes)}
            </p>
          )}
        </div>
      )}
    </li>
  );
}
