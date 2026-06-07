import { z } from 'zod';

// Disallowed: ASCII control, DEL, zero-width, bidi-override, BOM.
const DISALLOWED = /[\x00-\x1f\x7f\u200b-\u200d\u202a-\u202e\u2066-\u2069\ufeff]/;

function isBmpOnly(s: string): boolean {
  for (const ch of s) {
    if (ch.codePointAt(0)! > 0xffff) return false;
  }
  return true;
}

export const displayNameSchema = z
  .string()
  .transform((s) => s.trim())
  .refine((s) => s.length >= 1 && s.length <= 32, {
    message: 'display name must be 1-32 characters',
  })
  .refine((s) => !DISALLOWED.test(s), {
    message: 'display name contains disallowed characters',
  })
  .refine(isBmpOnly, {
    message: 'display name contains unsupported characters',
  });

export const knockBodySchema = z.object({
  display_name: displayNameSchema,
});

export type KnockBody = z.infer<typeof knockBodySchema>;

export const createSessionBodySchema = z.object({
  display_name: displayNameSchema,
});

export type CreateSessionBody = z.infer<typeof createSessionBodySchema>;
