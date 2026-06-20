import { useEffect, useState } from "react";
import { RiErrorWarningLine } from "react-icons/ri";
import { Modal } from "./ui/Modal";
import { Button } from "./ui/Button";
import { Tooltip } from "./ui/Tooltip";
import { Input } from "./ui/Input";
import { formatBytes, shortId } from "../lib/format";
import {
  isFsaaAvailable,
  FSAA_WARN_FLOOR,
  LARGE_FILE_WARN,
} from "../lib/webrtc";
import type { TransferFileMeta } from "../lib/socket";
import "./IncomingTransferModal.scss";

export interface IncomingRequest {
  transfer_id: string;
  from_user_id: string;
  from_name: string;
  files: TransferFileMeta[];
}

export function IncomingTransferModal({
  request,
  onAccept,
  onDecline,
}: {
  request: IncomingRequest | null;
  onAccept: (r: IncomingRequest, selected: number[], zipName?: string) => void;
  onDecline: (r: IncomingRequest) => void;
}) {
  const [confirmedLarge, setConfirmedLarge] = useState(false);
  // Indices of files the receiver wants; all selected by default.
  const [selected, setSelected] = useState<Set<number>>(new Set());
  // Receiver-chosen name for the multi-file .zip.
  const [zipName, setZipName] = useState("handover-files");

  // Reset selection (all on), the large-file confirmation, and the zip name
  // whenever a new request arrives.
  useEffect(() => {
    if (!request) return;
    setSelected(new Set(request.files.map((_, i) => i)));
    setConfirmedLarge(false);
    setZipName("handover-files");
  }, [request?.transfer_id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!request) return null;

  const fileCount = request.files.length;
  const selectedFiles = request.files.filter((_, i) => selected.has(i));
  const allSelected = selectedFiles.length === fileCount && fileCount > 0;

  // Warnings reflect only the files the receiver is actually accepting.
  const hasLarge = selectedFiles.some((f) => f.size > LARGE_FILE_WARN);
  const selectedBytes = selectedFiles.reduce((n, f) => n + f.size, 0);
  const fsaa = isFsaaAvailable();
  // Multiple files are bundled into one .zip; a single file streams to disk
  // when FSAA is available. Anything buffered (zip, or single file without
  // FSAA) is held in memory during the transfer.
  const zipped = selectedFiles.length > 1;
  const buffered = zipped || !fsaa;
  const memoryRisk = buffered && selectedBytes > FSAA_WARN_FLOOR;
  const canAccept = selected.size > 0 && (!hasLarge || confirmedLarge);

  function toggle(i: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) =>
      prev.size === fileCount
        ? new Set()
        : new Set(request!.files.map((_, i) => i))
    );
  }

  function accept() {
    onAccept(
      request!,
      [...selected].sort((a, b) => a - b),
      zipped ? zipName : undefined
    );
  }

  return (
    <Modal
      open={!!request}
      onClose={() => onDecline(request)}
      locked
      title={`${request.from_name} · ${shortId(request.from_user_id)} wants to send you files`}
      footer={
        <>
          <Button variant="ghost" onClick={() => onDecline(request)}>
            Decline
          </Button>
          <Button disabled={!canAccept} onClick={accept}>
            {selected.size > 0 ? `Accept ${selected.size}` : "Accept"}
          </Button>
        </>
      }
    >
      <label className="incoming_transfer_modal_selectall">
        <input type="checkbox" checked={allSelected} onChange={toggleAll} />
        <span>
          {selected.size} of {fileCount} selected
        </span>
      </label>

      <ul className="incoming_transfer_modal_list">
        {request.files.map((f, i) => (
          <li key={i} className="incoming_transfer_modal_item">
            <label className="incoming_transfer_modal_label">
              <input
                type="checkbox"
                checked={selected.has(i)}
                onChange={() => toggle(i)}
              />
              <Tooltip label={f.name} whenOverflowing>
                <span className="incoming_transfer_modal_name">{f.name}</span>
              </Tooltip>
            </label>
            <span className="incoming_transfer_modal_size">
              {formatBytes(f.size)}
            </span>
          </li>
        ))}
      </ul>

      {zipped && (
        <>
          <p className="incoming_transfer_modal_note">
            These {selectedFiles.length} files will be saved together as a
            single .zip.
          </p>
          <div className="incoming_transfer_modal_zipname">
            <Input
              label="Archive name"
              value={zipName}
              onChange={(e) => setZipName(e.target.value)}
              placeholder="handover-files"
              aria-label="Zip file name"
              autoComplete="off"
              spellCheck={false}
            />
            <span className="incoming_transfer_modal_zipname_suffix">.zip</span>
          </div>
        </>
      )}

      {memoryRisk && (
        <p className="incoming_transfer_modal_warn">
          <RiErrorWarningLine size={16} />
          Your browser holds these files in memory while transferring. For
          batches near 1&nbsp;GB, consider asking the sender to use the shared
          bucket instead.
        </p>
      )}

      {hasLarge && (
        <label className="incoming_transfer_modal_confirm">
          <input
            type="checkbox"
            checked={confirmedLarge}
            onChange={(e) => setConfirmedLarge(e.target.checked)}
          />
          <span>
            This includes a file over 2&nbsp;GB. I have enough disk/memory to
            receive it.
          </span>
        </label>
      )}
    </Modal>
  );
}
