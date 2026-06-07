/** Normalise a slug for case-insensitive use (matches the server). */
export function normalizeSlug(slug: string): string {
  return slug.trim().toLowerCase();
}

/** Build the in-session URL. */
export function sessionPath(slug: string): string {
  return `/s/${normalizeSlug(slug)}`;
}

/** Build the waiting-room URL. */
export function waitingPath(slug: string, knockId: string): string {
  return `/w/${normalizeSlug(slug)}?k=${encodeURIComponent(knockId)}`;
}
