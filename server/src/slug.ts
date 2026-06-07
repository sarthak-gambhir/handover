import { randomInt } from 'node:crypto';

const ADJECTIVES = [
  'amber', 'azure', 'brave', 'calm', 'clever', 'cosmic', 'crimson', 'dusky',
  'eager', 'fuzzy', 'gentle', 'golden', 'happy', 'hidden', 'icy', 'jolly',
  'keen', 'lively', 'lucky', 'mellow', 'misty', 'noble', 'plucky', 'purple',
  'quiet', 'rapid', 'rusty', 'shy', 'silent', 'silver', 'snowy', 'solar',
  'spry', 'sunny', 'swift', 'teal', 'tidy', 'vivid', 'witty', 'zesty',
];

const ANIMALS = [
  'otter', 'falcon', 'badger', 'lynx', 'heron', 'marten', 'gecko', 'panda',
  'tapir', 'koala', 'raven', 'finch', 'bison', 'moose', 'shrew', 'civet',
  'ferret', 'quokka', 'numbat', 'dingo', 'okapi', 'tahr', 'serval', 'caracal',
  'wombat', 'puffin', 'osprey', 'walrus', 'narwhal', 'mantis',
];

function pick<T>(arr: T[]): T {
  return arr[randomInt(arr.length)];
}

/** Generate a slug like "purple-otter-77". Always lowercase. */
export function makeSlug(): string {
  const n = randomInt(10, 100); // two-digit number
  return `${pick(ADJECTIVES)}-${pick(ANIMALS)}-${n}`;
}

/** Generate a slug not already present in `taken`, retrying on collision. */
export function makeUniqueSlug(taken: (slug: string) => boolean): string {
  for (let i = 0; i < 50; i++) {
    const slug = makeSlug();
    if (!taken(slug)) return slug;
  }
  // Extremely unlikely fallback: append more entropy.
  return `${makeSlug()}-${randomInt(1000, 10000)}`;
}

/** Normalise a slug for case-insensitive lookup. */
export function normalizeSlug(slug: string): string {
  return slug.trim().toLowerCase();
}
