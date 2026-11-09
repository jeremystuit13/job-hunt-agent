// Cross-source dedupe: Adzuna, Google for Jobs and the community lists surface the same posting
// under different spellings. The key must collapse those and keep genuinely different roles apart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jobId, normLocation } from '../scripts/lib/db.mjs';

test('same posting, different spellings → one id', () => {
  const a = jobId({ company: 'Stripe, Inc.', title: 'SWE Intern (Summer 2027)', location: 'SF' });
  const b = jobId({ company: 'Stripe', title: 'Software Engineer Intern', location: 'San Francisco, CA' });
  assert.equal(a, b);
});

test('different roles or places stay distinct', () => {
  const base = { company: 'Stripe', title: 'Software Engineer Intern', location: 'San Francisco, CA' };
  assert.notEqual(jobId(base), jobId({ ...base, title: 'Data Science Intern' }));
  assert.notEqual(jobId(base), jobId({ ...base, location: 'Seattle, WA' }));
  assert.notEqual(jobId(base), jobId({ ...base, company: 'Square' }));
});

test('location shorthands normalize', () => {
  assert.equal(normLocation('SF'), normLocation('San Francisco, CA'));
});
