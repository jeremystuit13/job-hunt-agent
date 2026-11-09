// The provenance guardrail is the project's core safety property: every rendered résumé line
// must trace to a bullet id in master.yaml, and the build must FAIL (writing nothing) otherwise.
// These tests run the real renderer against a throwaway database and the configured master.yaml
// (the fictional example candidate on a fresh clone).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'jobhunt-test-'));
process.env.JOBHUNT_DB = join(tmp, 'jobs.db');
const { open, upsert } = await import('../scripts/lib/db.mjs');
const { loadProfileConfig } = await import('../scripts/lib/config.mjs');

const JOB = { id: 'test' + Date.now().toString(16), track: 'internship', title: 'Software Engineer Intern',
  company: 'Example Corp', location: 'San Diego, CA', url: 'https://example.com/job', category: 'Software' };
upsert(open(), JOB, 'test');
const appDir = join(ROOT, 'applications', JOB.id);
after(() => { rmSync(tmp, { recursive: true, force: true }); rmSync(appDir, { recursive: true, force: true }); });

const render = () => spawnSync(process.execPath, ['scripts/render-resume.mjs', JOB.id],
  { cwd: ROOT, env: { ...process.env }, encoding: 'utf8', timeout: 120000 });

test('guardrail: a selection citing a bullet id that does not exist fails the build and writes no résumé', () => {
  mkdirSync(appDir, { recursive: true });
  writeFileSync(join(appDir, 'selection.json'), JSON.stringify({
    experiencePicks: [{ org: 'Fabricated Inc', sub: '', dates: '2026', bulletIds: ['INVENTED-CLAIM-1'] }],
  }));
  const r = render();
  assert.notEqual(r.status, 0, 'build must fail');
  assert.match(r.stderr, /not found in master\.yaml|GUARDRAIL/);
  assert.equal(existsSync(join(appDir, 'resume.pdf')), false, 'no résumé may be written');
  rmSync(join(appDir, 'selection.json'));
});

const chrome = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable', '/usr/bin/chromium'].some(existsSync) || process.env.CHROME_PATH;

test('end to end: builds a résumé whose every line is traced to master.yaml', { skip: !chrome && 'no Chrome' }, () => {
  const r = render();
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(appDir, 'resume.pdf')));
  const trace = JSON.parse(readFileSync(join(appDir, 'trace.json'), 'utf8'));
  assert.ok(trace.lines.length > 0);
  for (const line of trace.lines) assert.ok(line.sourceId, 'every line carries a source id');
  const answers = JSON.parse(readFileSync(join(appDir, 'answers.json'), 'utf8'));
  // A placeholder fact (work authorization = PENDING_DEFAULT) is flagged [CONFIRM], never stated as true.
  const auth = answers.find(a => /authorized/i.test(a.q));
  assert.equal(auth.confirm, loadProfileConfig().candidate.work_authorization === 'PENDING_DEFAULT');
  // A cover letter with no real job description keeps its honest [TODO] and gets no PDF.
  assert.match(readFileSync(join(appDir, 'cover.md'), 'utf8'), /\[TODO/);
  assert.equal(existsSync(join(appDir, 'cover.pdf')), false);
});
