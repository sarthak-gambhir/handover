import { RiUploadCloud2Line } from "react-icons/ri";
import { Dropzone } from "./ui/Dropzone";
import "./UploadDropzone.scss";

export function UploadDropzone({
  onFiles,
  disabled,
  encrypted = false,
}: {
  onFiles: (files: File[]) => void;
  disabled?: boolean;
  // When true, bucket files are end-to-end encrypted before they leave the
  // browser; the helper copy reflects that the server only stores ciphertext.
  encrypted?: boolean;
}) {
  return (
    <div className="upload_dropzone">
      <Dropzone onFiles={onFiles} disabled={disabled}>
        <RiUploadCloud2Line className="upload_dropzone_icon" size={28} />
        <p className="upload_dropzone_title">
          Drop files here or click to upload
        </p>
      </Dropzone>
      <p className="upload_dropzone_helper">
        {encrypted
          ? "Shared with everyone in the session and end-to-end encrypted — the server only ever stores ciphertext. For a 1:1 transfer, use “Send” on a member."
          : "Files here are visible to all session members and pass through the server. For private transfer, use “Send” on a member."}
      </p>
    </div>
  );
}
