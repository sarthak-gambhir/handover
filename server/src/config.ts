import 'dotenv/config';

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

const MB = 1024 * 1024;

export const config = {
  port: intEnv('PORT', 3000),
  host: process.env.HOST ?? '0.0.0.0',
  nodeEnv: process.env.NODE_ENV ?? 'development',
  isProd: process.env.NODE_ENV === 'production',
  clientOrigin: process.env.CLIENT_ORIGIN ?? 'http://localhost:5173',

  // Storage caps
  maxFileBytes: intEnv('MAX_FILE_BYTES', 100 * MB),
  maxSessionBytes: intEnv('MAX_SESSION_BYTES', 500 * MB),
  maxTotalBytes: intEnv('MAX_TOTAL_BYTES', 512 * MB),

  // Lifecycle timings (ms)
  sessionIdleMs: 60 * 60 * 1000, // 60 min
  ownerGraceMs: 60 * 1000, // 60 s after owner disconnect
  presenceGraceMs: 5 * 1000, // 5 s before marking offline
  knockTtlMs: 5 * 60 * 1000, // 5 min un-admitted knock TTL
  sweepIntervalMs: 60 * 1000, // sweeper tick

  // Cookie Max-Age (seconds)
  pendingCookieMaxAgeS: 5 * 60, // 300 s while pending
  memberCookieMaxAgeS: 60 * 60, // 3600 s while a member

  // Knock queue
  knockQueueCap: 50,

  // Ownership offer TTL (ms) — an unaccepted offer expires after this.
  ownerOfferTtlMs: 60 * 1000,

  // Signaling per-state timeouts (ms)
  transferTimeouts: {
    requested: 30 * 1000,
    accepted: 60 * 1000,
    offering: 30 * 1000,
  } as Record<string, number>,
  transferGcMs: 5 * 60 * 1000, // GC terminal transfers older than 5 min

  // WebRTC ICE config
  turnUrl: process.env.TURN_URL,
  turnUsername: process.env.TURN_USERNAME,
  turnCredential: process.env.TURN_CREDENTIAL,
} as const;

export const MB_BYTES = MB;
