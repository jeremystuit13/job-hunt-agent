#!/usr/bin/env node
// Prepares what goes to the board. Run pull-status.mjs first.
//
// Slice (M13, 2026-11-04): EVERY open, in-scope job in both tracks (status 'new' — gated ones are
// out of scope by definition), PLUS every job a human has acted on regardless of score/closed/gated.
// It used to be a top-40/top-30 slice; the user saw 43 internships out of ~1,800 found and asked for all.
//
// NO-CLOBBER POLICY (learned the hard way): a bulk `set` on an existing board doc would
// wipe `status` and `package`, which live on the board and are owned by the user. So:
//   * docs NOT yet on the board  -> board-new.json      (full docs, safe to `set`)
//   * docs already on the board  -> board-refresh.json  (score fields only, for `update`)
// Existing ids come from data/board-pull/jobs (written by Artifact read_db --out_dir).
// The actual write_db calls are made from the Claude session (a subprocess can't reach
// the Artifact tool), in batches of <= 50.

import { writeFileSync, readdirSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { open, ROOT } from './lib/db.mjs';
import { hourlyPay, milesFromHome, roleGroup, locationTier } from './lib/derive.mjs';

const db = open();
const ACTED = "('shortlisted','tailoring','ready','applied','interview','offer','rejected','dismissed')";

const pullDir = join(ROOT, 'data', 'board-pull', 'jobs');
const onBoard = new Set(existsSync(pullDir)
  ? readdirSync(pullDir).filter(f => f.endsWith('.json')).map(f => f.replace('.json', '')) : []);
if (!onBoard.size) console.warn('  ⚠ no pulled board data — treating every doc as new. Run read_db first.');

function selectTrack(track) {
  const acted = db.prepare(`SELECT * FROM jobs WHERE track=? AND status IN ${ACTED}`).all(track);
  const open_ = db.prepare(`SELECT * FROM jobs WHERE track=? AND closed_at IS NULL
    AND status='new' AND score IS NOT NULL ORDER BY score DESC`).all(track);
  const seen = new Set(acted.map(r => r.id));
  return [...acted, ...open_.filter(r => !seen.has(r.id))];
}

const j = s => (s ? JSON.parse(s) : null);
const toDoc = row => ({
  id: row.id, track: row.track, title: row.title, company: row.company,
  location: row.location, url: row.url, source: j(row.sources ?? '[]').join('+'),
  posted_at: row.posted_at, deadline: row.deadline,
  pay_min: row.pay_min, pay_max: row.pay_max, pay_period: row.pay_period,
  category: row.category, remote: !!row.remote, score: row.score,
  subscores: j(row.subscores), rationale: row.rationale, gap: row.gap,
  status: row.status, first_seen: row.first_seen, last_seen: row.last_seen,
  closed: !!row.closed_at,
  // derived for display + filters (same functions the scorer used)
  hourly: (h => h == null ? null : Math.round(h * 100) / 100)(hourlyPay(row)),
  miles: (m => m == null ? null : Math.round(m))(milesFromHome(row)),
  role_group: roleGroup(row),
  region: locationTier(row),
});
const scoreOnly = d => ({ url: d.url, score: d.score, subscores: d.subscores, rationale: d.rationale, gap: d.gap, category: d.category, location: d.location, role_group: d.role_group, region: d.region, miles: d.miles, hourly: d.hourly, closed: d.closed, pay_min: d.pay_min, pay_max: d.pay_max, pay_period: d.pay_period });

const slice = [...selectTrack('internship'), ...selectTrack('parttime')].map(toDoc);
const fresh = slice.filter(d => !onBoard.has(d.id));
// Only refresh docs whose score-derived fields actually differ from what's on the board.
const boardDoc = id => { try { const d = JSON.parse(readFileSync(join(pullDir, id + '.json'), 'utf8')); return d.data ?? d; } catch { return null; } };
// Canonical form: keys sorted (the board stores them alphabetically) + numbers at 3 decimals.
const canon = (v, dp = 3) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k], dp)]))
  : typeof v === 'number' ? Math.round(v * 10 ** dp) / 10 ** dp : v;
// Drift tolerance: urgency is computed from posting age, so every score creeps a little every day.
// With ~2,000 docs on the board, comparing at 3 decimals would rewrite nearly all of them daily.
// Refresh when the score moves >= 0.02 (2 points on the board) or a subscore moves >= 0.1, or any
// non-score field changes. Displayed numbers may lag by a point or two between refreshes.
const r1 = o => JSON.stringify(canon(o, 1));
const differs = d => { const b = boardDoc(d.id); return !b || Math.abs((b.score ?? -1) - d.score) >= 0.02
  || b.rationale !== d.rationale || b.gap !== d.gap || r1(b.subscores) !== r1(d.subscores)
  || b.category !== d.category || b.location !== d.location || b.role_group !== d.role_group
  || (b.region ?? null) !== (d.region ?? null) || b.url !== d.url
  || (b.miles ?? null) !== (d.miles ?? null) || (b.hourly ?? null) !== (d.hourly ?? null)
  || !!b.closed !== !!d.closed || (b.pay_min ?? null) !== (d.pay_min ?? null); };
const refresh = slice.filter(d => onBoard.has(d.id) && differs(d));

const out = (name, data) => writeFileSync(join(ROOT, 'data', name), JSON.stringify(data, null, 2));
// Baked into board.html as first paint / offline fallback only — the live db snapshot carries
// everything. Kept small (top 100 per track + acted-on) so the page itself stays light.
const SEED_N = 100;
const seedOf = t => { const all = slice.filter(d => d.track === t);
  const acted = all.filter(d => d.status !== 'new'); const rest = all.filter(d => d.status === 'new').slice(0, SEED_N);
  return [...acted, ...rest]; };
out('board-seed.json', { generated_at: new Date().toISOString(), internships: seedOf('internship'), parttime: seedOf('parttime') });
// Bodies go in per-doc files and the batch entries reference them by file_path, so the
// Claude session never has to paste tens of KB of JSON into a tool call.
const wdir = join(ROOT, 'data', 'board-writes');
rmSync(wdir, { recursive: true, force: true });
mkdirSync(join(wdir, 'new'), { recursive: true });
mkdirSync(join(wdir, 'refresh'), { recursive: true });
const entry = (op, kind, d, body) => {
  const file_path = join(wdir, kind, d.id + '.json');
  writeFileSync(file_path, JSON.stringify(body));
  return { op, collection: 'jobs', doc_id: d.id, file_path };
};
out('board-new.json', fresh.map(d => entry('set', 'new', d, d)));
// Board docs that fell out of the slice are removed — but ONLY if still untouched
// (status 'new' on the board). Anything the user acted on is never deleted.
const inSlice = new Set(slice.map(d => d.id));
const stale = [...onBoard].filter(id => {
  if (inSlice.has(id)) return false;
  try { const d = JSON.parse(readFileSync(join(pullDir, id + '.json'), 'utf8')); return (d.data ?? d).status === 'new'; }
  catch { return false; }
});
out('board-remove.json', stale.map(id => ({ op: 'delete', collection: 'jobs', doc_id: id })));
out('board-refresh.json', refresh.map(d => entry('update', 'refresh', d, scoreOnly(d))));

console.log(`slice: ${slice.length} docs  (${slice.filter(d=>d.track==='internship').length} internship, ${slice.filter(d=>d.track==='parttime').length} part-time)`);
console.log(`  new to board:     ${fresh.length}   -> data/board-new.json     (set)`);
console.log(`  already on board: ${refresh.length}   -> data/board-refresh.json (score-only update)`);
console.log(`  stale untouched docs to remove: ${stale.length} -> data/board-remove.json (delete)`);
