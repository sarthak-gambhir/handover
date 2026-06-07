import { describe, it, expect } from 'vitest';
import { sanitizeFilename } from './lib/sanitize_filename.js';

describe('sanitizeFilename', () => {
  const cases: Array<[string, string]> = [
    ['My Doc.PDF', 'my-doc.pdf'],
    ['My Resume (final).PDF', 'my-resume-final.pdf'],
    ['../../etc/passwd', 'etc-passwd'],
    ['résumé.docx', 'r-sum.docx'],
    ['中文.pdf', 'pdf'],
    ['utc-timestamp-data_store_v0.test.md', 'utc-timestamp-data_store_v0.test.md'],
    ['   spaced   name   .txt', 'spaced-name.txt'],
    ['UPPER___CASE.TXT', 'upper___case.txt'],
    ['a....b.txt', 'a....b.txt'],
    ['---leading-and-trailing---', 'leading-and-trailing'],
    ['', 'download'],
    ['!!!', 'download'],
    ['.hidden', 'hidden'],
  ];

  for (const [input, expected] of cases) {
    it(`"${input}" -> "${expected}"`, () => {
      expect(sanitizeFilename(input)).toBe(expected);
    });
  }

  it('only emits [a-z0-9._-]', () => {
    const out = sanitizeFilename('Wéird Ñame *with* symbols!.JPג');
    expect(out).toMatch(/^[a-z0-9._-]+$/);
  });

  it('caps length at 200 while keeping an extension', () => {
    const long = 'a'.repeat(500) + '.pdf';
    const out = sanitizeFilename(long);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.endsWith('.pdf')).toBe(true);
  });
});
