import { useState } from "react";
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

  function addFiles(picked: File[]) {
    setFiles((prev) => [...prev, ...picked].slice(0, MAX_TRANSFER_FILES));
  }

  function reset() {
    setFiles([]);
    onClose();
  }

  if (!recipient) return null;
  const tooMany = files.length >= MAX_TRANSFER_FILES;

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
            disabled={files.length === 0}
            onClick={() => {
              onSend(recipient, files);
              setFiles([]);
            }}
          >
            Send {files.length > 0 ? `(${files.length})` : ""}
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
        <ul className="send_file_modal_list">
          {files.map((f, i) => (
            <li key={i} className="send_file_modal_item">
              <span className="send_file_modal_filename" title={f.name}>
                {f.name}
              </span>
              <span className="send_file_modal_size">
                {formatBytes(f.size)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
