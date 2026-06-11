export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`;
}

export function formatRate(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`;
}

export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.ceil(seconds % 60);
  return `${m}m ${s}s`;
}

export function relativeTime(ts: number): string {
  const diff = Math.max(0, Date.now() - ts);
  const s = Math.floor(diff / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

/** Human "expires in …" for a future timestamp; "expired" once past. */
export function expiresIn(ts: number): string {
  const diff = ts - Date.now();
  if (diff <= 0) return 'expired';
  const m = Math.round(diff / 60000);
  if (m < 1) return 'expires in <1m';
  if (m < 60) return `expires in ${m}m`;
  const h = Math.floor(m / 60);
  return `expires in ${h}h`;
}

/** Last 4 chars of a user_id for collision disambiguation. */
export function shortId(userId: string): string {
  return userId.replace(/-/g, '').slice(-6);
}
