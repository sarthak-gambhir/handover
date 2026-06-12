import { RiDownloadLine, RiDeleteBin6Line, RiFileLine } from "react-icons/ri";
import { Badge } from "./ui/Badge";
import { Button } from "./ui/Button";
import type { PublicBucketEntry } from "../lib/api";
import { formatBytes, relativeTime } from "../lib/format";
import { cx } from "../lib/cx";
import "./FileRow.scss";

interface FileRowProps {
  entry: PublicBucketEntry;
  uploaderName: string;
  isYours: boolean;
  justAdded: boolean;
  downloadUrl: string;
  onDelete: (id: string) => void;
  // Whether the current viewer may delete this file. Defaults to isYours; the
  // owner can delete any file (including orphaned ones).
  canDelete?: boolean;
  progress?: number; // 0..1 while uploading; undefined when stored
  onCancelUpload?: () => void;
  // When the session is frozen, downloads and deletes are locked.
  frozen?: boolean;
}

export function FileRow({
  entry,
  uploaderName,
  isYours,
  justAdded,
  downloadUrl,
  onDelete,
  canDelete,
  progress,
  onCancelUpload,
  frozen = false,
}: FileRowProps) {
  const showDelete = (canDelete ?? isYours) && !frozen;
  const uploading = progress !== undefined;
  return (
    <li className={cx("file_row", justAdded && "file_row_just_added")}>
      <RiFileLine className="file_row_icon" size={18} />
      <div className="file_row_main">
        <span className="file_row_name" title={entry.name}>
          {entry.name}
        </span>
        <div className="file_row_meta">
          <span className="file_row_size">{formatBytes(entry.size)}</span>
          <Badge variant={isYours ? "accent" : "neutral"}>
            {isYours ? "you" : uploaderName}
          </Badge>
          {!uploading && (
            <span className="file_row_time">
              {relativeTime(entry.created_at)}
            </span>
          )}
        </div>
        {uploading && (
          <div
            className="file_row_progress"
            role="progressbar"
            aria-label={`Uploading ${entry.name}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round((progress ?? 0) * 100)}
          >
            <div
              className="file_row_progress_bar"
              style={{ width: `${(progress ?? 0) * 100}%` }}
            />
          </div>
        )}
      </div>
      <div className="file_row_actions">
        {uploading ? (
          <Button size="sm" variant="ghost" onClick={onCancelUpload}>
            Cancel
          </Button>
        ) : (
          <>
            <a
              className={cx(
                "file_row_download",
                frozen && "file_row_download_disabled"
              )}
              href={frozen ? undefined : downloadUrl}
              download={frozen ? undefined : entry.name}
              aria-disabled={frozen || undefined}
              aria-label={
                frozen
                  ? `Download ${entry.name} (locked while frozen)`
                  : `Download ${entry.name}`
              }
              onClick={frozen ? (e) => e.preventDefault() : undefined}
            >
              <RiDownloadLine size={16} />
            </a>
            {showDelete && (
              <Button
                size="sm"
                variant="ghost"
                icon={<RiDeleteBin6Line size={16} />}
                aria-label={`Delete ${entry.name}`}
                onClick={() => onDelete(entry.id)}
              />
            )}
          </>
        )}
      </div>
    </li>
  );
}
