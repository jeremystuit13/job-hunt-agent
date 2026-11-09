import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bestApplyUrl } from '../scripts/lib/util.mjs';

test("bestApplyUrl prefers the employer's own link and strips tracking params", () => {
  const url = bestApplyUrl('Acme', [
    { title: 'Acme Careers', link: 'https://jobs.acme.com/1?utm_source=x' },
    { title: 'LinkedIn', link: 'https://linkedin.com/jobs/view/1' },
  ], 'https://google.com/x');
  assert.equal(url, 'https://jobs.acme.com/1');
});

test("bestApplyUrl never takes another company's link — falls back instead", () => {
  assert.equal(bestApplyUrl('Acme', [{ title: 'Other Co', link: 'https://other.com/j' }], 'https://google.com/fallback'),
    'https://google.com/fallback');
});
