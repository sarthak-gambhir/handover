import { useState } from "react";
import { RiCloseLine } from "react-icons/ri";
import { Modal } from "./ui/Modal";
import { Button } from "./ui/Button";
import { Dropzone } from "./ui/Dropzone";
import type { PublicMember } from "../lib/api";
import { formatBytes, shortId } from "../lib/format";
import { MAX_TRANSFER_FILES } from "../lib/webrtc";
import "./SendFileModal.scss";

interface SendFileModalProps {
  recipient: PublicMember | null;
  onClose: () => void;
  onSend: (recipient: PublicMember, files: File[]) => void;
}

export function SendFileModal({
  recipient,
  onClose,
  onSend,
}: SendFileModalProps) {
  const [files, setFiles] = useState<File[]>([]);
  // Which staged files will actually be sent. Tracked by File identity (not
  // index) so it survives add/remove without shifting.
  const [selected, setSelected] = useState<Set<File>>(new Set());

  function addFiles(picked: File[]) {
    setFiles((prev) => [...prev, ...picked].slice(0, MAX_TRANSFER_FILES));
    setSelected((prev) => {
      const next = new Set(prev);
      for (const f of picked) next.add(f);
      return next;
    });
  }

  function removeFile(index: number) {
    const removed = files[index];
    setFiles((prev) => prev.filter((_, i) => i !== index));
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(removed);
      return next;
    });
  }

  function toggle(file: File) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(file)) next.delete(file);
      else next.add(file);
      return next;
    });
  }

  function reset() {
    setFiles([]);
    setSelected(new Set());
    onClose();
  }

  if (!recipient) return null;
  const tooMany = files.length >= MAX_TRANSFER_FILES;
  const selectedFiles = files.filter((f) => selected.has(f));
  const allSelected = files.length > 0 && selectedFiles.length === files.length;

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(files));
  }

  return (
    <Modal
      open={!!recipient}
      onClose={reset}
      title={`Send to ${recipient.display_name} · ${shortId(recipient.user_id)}`}
      footer={
        <>
          <Button variant="ghost" onClick={reset}>
            Cancel
          </Button>
          <Button
            disabled={selectedFiles.length === 0}
            onClick={() => {
              onSend(recipient, selectedFiles);
              setFiles([]);
              setSelected(new Set());
            }}
          >
            Send {selectedFiles.length > 0 ? `(${selectedFiles.length})` : ""}
          </Button>
        </>
      }
    >
      <p className="send_file_modal_note">
        Files go directly to {recipient.display_name} over an encrypted peer
        connection — they never touch the server.
      </p>
      <Dropzone onFiles={addFiles} disabled={tooMany}>
        <span className="send_file_modal_pick">
          {tooMany
            ? `Maximum ${MAX_TRANSFER_FILES} files`
            : "Choose files or drop them here"}
        </span>
      </Dropzone>
      {files.length > 0 && (
        <>
          <label className="send_file_modal_selectall">
            <input type="checkbox" checked={allSelected} onChange={toggleAll} />
            <span>
              {selectedFiles.length} of {files.length} selected
            </span>
          </label>
          <ul className="send_file_modal_list">
            {files.map((f, i) => (
              <li key={i} className="send_file_modal_item">
                <label className="send_file_modal_label">
                  <input
                    type="checkbox"
                    checked={selected.has(f)}
                    onChange={() => toggle(f)}
                  />
                  <span className="send_file_modal_filename" title={f.name}>
                    {f.name}
                  </span>
                </label>
                <span className="send_file_modal_size">
                  {formatBytes(f.size)}
                </span>
                <button
                  type="button"
                  className="send_file_modal_remove"
                  aria-label={`Remove ${f.name}`}
                  onClick={() => removeFile(i)}
                >
                  <RiCloseLine size={16} />
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </Modal>
  );
}
