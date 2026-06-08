import { RiDownloadLine, RiUploadLine, RiCloseLine } from "react-icons/ri";
import { Button } from "./ui/Button";
import type { TransferVM } from "../lib/transfer_types";
import { isTerminal } from "../lib/transfer_types";
import { formatRate, formatEta } from "../lib/format";
import { cx } from "../lib/cx";
import "./TransferProgressRow.scss";

const STATUS_LABEL: Record<string, string> = {
  requesting: "Waiting to accept…",
  connecting: "Connecting…",
  transferring: "Transferring",
  complete: "Complete",
  declined: "Declined",
  cancelled: "Cancelled",
  failed: "Failed",
};

export function TransferProgressRow({
  transfer,
  onCancel,
  onDismiss,
}: {
  transfer: TransferVM;
  onCancel: (t: TransferVM) => void;
  onDismiss: (t: TransferVM) => void;
}) {
  const terminal = isTerminal(transfer.status);
  const label =
    transfer.files.length === 1
      ? transfer.files[0].name
      : `${transfer.files.length} files`;

  return (
    <li
      className={cx(
        "transfer_progress_row",
        `transfer_progress_row_${transfer.status}`,
      )}
    >
      <span className="transfer_progress_row_icon">
        {transfer.role === "sender" ? (
          <RiUploadLine size={16} />
        ) : (
          <RiDownloadLine size={16} />
        )}
      </span>
      <div className="transfer_progress_row_main">
        <div className="transfer_progress_row_head">
          <span className="transfer_progress_row_name" title={label}>
            {label}
          </span>
          <span className="transfer_progress_row_peer">
            {transfer.role === "sender" ? "to" : "from"} {transfer.peer_name}
          </span>
        </div>
        <div
          className="transfer_progress_row_track"
          role="progressbar"
          aria-label={`Transfer ${label}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(transfer.fraction * 100)}
        >
          <div
            className="transfer_progress_row_fill"
            style={{ width: `${Math.round(transfer.fraction * 100)}%` }}
          />
        </div>
        <div className="transfer_progress_row_meta">
          <span>{transfer.message ?? STATUS_LABEL[transfer.status]}</span>
          {transfer.status === "transferring" && (
            <span className="transfer_progress_row_stats">
              {Math.round(transfer.fraction * 100)}%
              {transfer.bytesPerSec
                ? ` · ${formatRate(transfer.bytesPerSec)}`
                : ""}
              {transfer.etaSec !== undefined
                ? ` · ${formatEta(transfer.etaSec)}`
                : ""}
            </span>
          )}
        </div>
      </div>
      <div className="transfer_progress_row_actions">
        {terminal ? (
          <Button
            size="sm"
            variant="ghost"
            icon={<RiCloseLine size={16} />}
            aria-label="Dismiss"
            onClick={() => onDismiss(transfer)}
          />
        ) : (
          <Button size="sm" variant="ghost" onClick={() => onCancel(transfer)}>
            Cancel
          </Button>
        )}
      </div>
    </li>
  );
}
