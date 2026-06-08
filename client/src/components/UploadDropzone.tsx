import { RiUploadCloud2Line } from "react-icons/ri";
import { Dropzone } from "./ui/Dropzone";
import "./UploadDropzone.scss";

export function UploadDropzone({
  onFiles,
  disabled,
}: {
  onFiles: (files: File[]) => void;
  disabled?: boolean;
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
        Files here are visible to all session members and pass through the
        server. For private transfer, use “Send” on a member.
      </p>
    </div>
  );
}
