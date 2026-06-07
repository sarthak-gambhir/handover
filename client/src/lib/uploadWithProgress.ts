import { normalizeSlug } from './slug';
import type { PublicBucketEntry } from './api';

export interface UploadHandle {
  promise: Promise<PublicBucketEntry>;
  abort: () => void;
  onProgress: (cb: (fraction: number) => void) => void;
}

/**
 * XHR-based upload so we get real progress events and cancellation. Sends the
 * `st_<slug>` cookie via `withCredentials`. Rejects with an `{ status, code }`
 * shaped error so the caller can surface 507 / 413 etc.
 */
export function uploadWithProgress(slug: string, file: File): UploadHandle {
  const xhr = new XMLHttpRequest();
  let progressCb: ((f: number) => void) | null = null;

  const promise = new Promise<PublicBucketEntry>((resolve, reject) => {
    xhr.open('POST', `/api/sessions/${normalizeSlug(slug)}/files`);
    xhr.withCredentials = true;

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable && progressCb) progressCb(e.loaded / e.total);
    });

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as PublicBucketEntry);
        } catch {
          reject({ status: xhr.status, code: 'bad_response' });
        }
      } else {
        let code = `http_${xhr.status}`;
        try {
          const body = JSON.parse(xhr.responseText);
          if (body?.error) code = body.error;
        } catch {
          // ignore
        }
        reject({ status: xhr.status, code });
      }
    });

    xhr.addEventListener('error', () => reject({ status: 0, code: 'network_error' }));
    xhr.addEventListener('abort', () => reject({ status: 0, code: 'aborted' }));

    const form = new FormData();
    form.append('file', file);
    xhr.send(form);
  });

  return {
    promise,
    abort: () => xhr.abort(),
    onProgress: (cb) => {
      progressCb = cb;
    },
  };
}
