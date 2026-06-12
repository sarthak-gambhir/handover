import { useCallback, useState } from "react";
import { api } from "./api";
import type { PublicBucketEntry } from "./api";
import { useToast } from "../components/ui/Toast";
import { randomId } from "./id";

export interface UploadVM {
  tempId: string;
  entry: PublicBucketEntry;
  fraction: number;
  abort: () => void;
}

/**
 * Shared-bucket upload management, split out of useSession: tracks in-flight
 * uploads (with progress + abort) and exposes upload/delete actions.
 */
export function useBucketUploads(slug: string, yourUserId: string) {
  const { toast } = useToast();
  const [uploads, setUploads] = useState<UploadVM[]>([]);

  const uploadFiles = useCallback(
    (files: File[]) => {
      for (const file of files) {
        const tempId = randomId();
        // imported lazily to avoid a cycle at module top
        import("./uploadWithProgress").then(({ uploadWithProgress }) => {
          const handle = uploadWithProgress(slug, file);
          const placeholder: PublicBucketEntry = {
            id: tempId,
            name: file.name,
            size: file.size,
            content_type: file.type || "application/octet-stream",
            uploader_id: yourUserId,
            created_at: Date.now(),
          };
          setUploads((prev) => [
            ...prev,
            { tempId, entry: placeholder, fraction: 0, abort: handle.abort },
          ]);
          handle.onProgress((f) =>
            setUploads((prev) =>
              prev.map((u) => (u.tempId === tempId ? { ...u, fraction: f } : u))
            )
          );
          handle.promise
            .then(() =>
              setUploads((prev) => prev.filter((u) => u.tempId !== tempId))
            )
            .catch((err: { code?: string }) => {
              setUploads((prev) => prev.filter((u) => u.tempId !== tempId));
              if (err?.code === "insufficient_storage")
                toast("Server is at capacity — try again in a minute.", "warn");
              else if (err?.code === "file_too_large")
                toast("That file is over the 100 MB limit.", "warn");
              else if (err?.code === "session_frozen")
                toast("Session is frozen — uploads are paused.", "warn");
              else if (err?.code === "aborted") {
                /* silent */
              } else toast("Upload failed.", "danger");
            });
        });
      }
    },
    [slug, yourUserId, toast]
  );

  const deleteFile = useCallback(
    async (id: string) => {
      try {
        await api.deleteFile(slug, id);
      } catch {
        toast("Could not delete the file.", "danger");
      }
    },
    [slug, toast]
  );

  return { uploads, uploadFiles, deleteFile };
}
