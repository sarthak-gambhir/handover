import { useRef, useState, type ReactNode } from "react";
import { cx } from "../../lib/cx";
import "./Dropzone.scss";

interface DropzoneProps {
  onFiles: (files: File[]) => void;
  multiple?: boolean;
  disabled?: boolean;
  children?: ReactNode;
}

export function Dropzone({
  onFiles,
  multiple = true,
  disabled = false,
  children,
}: DropzoneProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [active, setActive] = useState(false);

  function pick(files: FileList | null) {
    if (!files || files.length === 0) return;
    onFiles(Array.from(files));
  }

  return (
    <div
      className={cx(
        "dropzone",
        active && "dropzone_active",
        disabled && "dropzone_disabled"
      )}
      role="button"
      tabIndex={disabled ? -1 : 0}
      onClick={() => !disabled && inputRef.current?.click()}
      onKeyDown={(e) => {
        if (!disabled && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          inputRef.current?.click();
        }
      }}
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setActive(true);
      }}
      onDragLeave={() => setActive(false)}
      onDrop={(e) => {
        e.preventDefault();
        setActive(false);
        if (!disabled) pick(e.dataTransfer.files);
      }}
    >
      <input
        ref={inputRef}
        type="file"
        className="dropzone_input"
        multiple={multiple}
        disabled={disabled}
        onChange={(e) => {
          pick(e.target.files);
          e.target.value = "";
        }}
      />
      {children}
    </div>
  );
}
