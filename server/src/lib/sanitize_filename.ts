/**
 * Canonicalise an uploaded filename to a safe, ASCII-only form.
 *
 * Rules (G8):
 *  1. lowercase
 *  2. replace any char not in [a-z0-9._-] with '-'
 *  3. collapse consecutive '-' runs into a single '-'
 *  4. trim leading/trailing '-', '_', '.'
 *  5. fallback to 'download' if empty
 *  6. cap total length at 200 chars (preserving a trailing extension if present)
 *
 * The result is pure ASCII so it can be embedded directly in a
 * `Content-Disposition: attachment; filename="..."` header.
 */
const MAX_LEN = 200;

export function sanitizeFilename(input: string): string {
  let name = (input ?? "").toLowerCase();

  // 2. replace disallowed chars with '-'
  name = name.replace(/[^a-z0-9._-]/g, "-");
  // 3. collapse '-' runs
  name = name.replace(/-+/g, "-");
  // 3b. drop dashes adjacent to dots so extensions stay clean (e.g. "final-.pdf" -> "final.pdf")
  let prev: string;
  do {
    prev = name;
    name = name.replace(/-\.|\.-/g, ".");
  } while (name !== prev);
  // 4. trim leading/trailing separators
  name = name.replace(/^[-_.]+/, "").replace(/[-_.]+$/, "");

  // 5. fallback
  if (name.length === 0) return "download";

  // 6. length cap, preserving extension
  if (name.length > MAX_LEN) {
    const dot = name.lastIndexOf(".");
    if (dot > 0 && name.length - dot <= 16) {
      const ext = name.slice(dot);
      name = name.slice(0, MAX_LEN - ext.length) + ext;
    } else {
      name = name.slice(0, MAX_LEN);
    }
    name = name.replace(/[-_.]+$/, "");
    if (name.length === 0) return "download";
  }

  return name;
}
