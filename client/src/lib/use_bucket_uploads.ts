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
 *
 * `prepareUpload` transforms each file into the bytes actually sent — it
 * encrypts the file when E2EE is active, or returns it unchanged otherwise.
 */
export function useBucketUploads(
  slug: string,
  yourUserId: string,
  prepareUpload: (file: File) => Promise<Blob | File>
) {
  const { toast } = useToast();
  const [uploads, setUploads] = useState<UploadVM[]>([]);

  const uploadFiles = useCallback(
    (files: File[]) => {
      for (const file of files) {
        const tempId = randomId();
        // Show a placeholder immediately, then encrypt + upload.
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
          { tempId, entry: placeholder, fraction: 0, abort: () => undefined },
        ]);
        const fail = (code?: string) => {
          setUploads((prev) => prev.filter((u) => u.tempId !== tempId));
          if (code === "insufficient_storage")
            toast("Server is at capacity — try again in a minute.", "warn");
          else if (code === "file_too_large")
            toast("That file is over the 100 MB limit.", "warn");
          else if (code === "session_frozen")
            toast("Session is frozen — uploads are paused.", "warn");
          else if (code === "key_not_ready")
            toast("Encryption key is still syncing — try again.", "warn");
          else if (code === "aborted") {
            /* silent */
          } else toast("Upload failed.", "danger");
        };
        // imported lazily to avoid a cycle at module top
        Promise.all([import("./uploadWithProgress"), prepareUpload(file)])
          .then(([{ uploadWithProgress }, body]) => {
            const handle = uploadWithProgress(slug, body, file.name);
            setUploads((prev) =>
              prev.map((u) =>
                u.tempId === tempId ? { ...u, abort: handle.abort } : u
              )
            );
            handle.onProgress((f) =>
              setUploads((prev) =>
                prev.map((u) =>
                  u.tempId === tempId ? { ...u, fraction: f } : u
                )
              )
            );
            handle.promise
              .then(() =>
                setUploads((prev) => prev.filter((u) => u.tempId !== tempId))
              )
              .catch((err: { code?: string }) => fail(err?.code));
          })
          .catch((err: { code?: string }) => fail(err?.code));
      }
    },
    [slug, yourUserId, prepareUpload, toast]
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
