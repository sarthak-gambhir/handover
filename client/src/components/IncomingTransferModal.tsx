import { useState } from 'react';
import { FaTriangleExclamation } from 'react-icons/fa6';
import { Modal } from './ui/Modal';
import { Button } from './ui/Button';
import { formatBytes, shortId } from '../lib/format';
import { isFsaaAvailable, FSAA_WARN_FLOOR, LARGE_FILE_WARN } from '../lib/webrtc';
import type { TransferFileMeta } from '../lib/socket';
import './IncomingTransferModal.scss';

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
  onAccept: (r: IncomingRequest) => void;
  onDecline: (r: IncomingRequest) => void;
}) {
  const [confirmedLarge, setConfirmedLarge] = useState(false);

  if (!request) return null;

  const hasLarge = request.files.some((f) => f.size > LARGE_FILE_WARN);
  const fsaa = isFsaaAvailable();
  const memoryRisk = !fsaa && request.files.some((f) => f.size > FSAA_WARN_FLOOR);
  const manyFiles = request.files.length > 8;
  const canAccept = !hasLarge || confirmedLarge;

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
          <Button disabled={!canAccept} onClick={() => onAccept(request)}>
            Accept
          </Button>
        </>
      }
    >
      <ul className="incoming_transfer_modal_list">
        {request.files.map((f, i) => (
          <li key={i} className="incoming_transfer_modal_item">
            <span className="incoming_transfer_modal_name" title={f.name}>
              {f.name}
            </span>
            <span className="incoming_transfer_modal_size">{formatBytes(f.size)}</span>
          </li>
        ))}
      </ul>

      {manyFiles && (
        <p className="incoming_transfer_modal_note">
          That’s a lot of files ({request.files.length}). They’ll arrive one after another.
        </p>
      )}

      {memoryRisk && (
        <p className="incoming_transfer_modal_warn">
          <FaTriangleExclamation size={16} />
          Your browser will hold this file in memory while transferring. For files near 1&nbsp;GB,
          consider asking the sender to use the shared bucket instead.
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
            This includes a file over 2&nbsp;GB. I have enough disk/memory to receive it.
          </span>
        </label>
      )}
    </Modal>
  );
}
