#!/usr/bin/env node
// Sync the board's human-owned state (status, package) back into local sqlite.
//
// Only the Claude session can read the artifact's database (it goes through the
// Artifact tool, not something a subprocess can call), so the flow is:
//   1. Claude: Artifact read_db  jobs  --out_dir data/board-pull
//   2. this script reads those JSON files and updates sqlite.
// Run BEFORE push.mjs, so the local corpus knows what the user starred/applied to.
//
// Usage: node scripts/pull-status.mjs [dir]   (default data/board-pull/jobs)

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { open, ROOT } from './lib/db.mjs';

const dir = process.argv[2] ?? join(ROOT, 'data', 'board-pull', 'jobs');
if (!existsSync(dir)) { console.error(`no pulled board data at ${dir}`); process.exit(1); }

const db = open();
const upd = db.prepare(`UPDATE jobs SET status = ?, status_updated = ? WHERE id = ?`);
const cur = db.prepare('SELECT status FROM jobs WHERE id = ?');
let changed = 0, missing = 0, same = 0;

for (const f of readdirSync(dir).filter(f => f.endsWith('.json'))) {
  const raw = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  const doc = raw.data ?? raw;          // read_db wraps the body in {id, data, version}
  const id = doc.id ?? raw.id ?? f.replace('.json', '');
  const row = cur.get(id);
  if (!row) { missing++; continue; }
  const status = doc.status ?? 'new';
  if (status === row.status) { same++; continue; }
  // 'gated' is the scorer's verdict, not the user's. A board doc still saying 'new' only means it was
  // pushed before the gate existed (SailPoint "Remote in UK", 2026-11-04) — never un-gate from that.
  if (status === 'new' && row.status === 'gated') { same++; continue; }
  upd.run(status, doc.status_updated ?? new Date().toISOString(), id);
  console.log(`  ${id}: ${row.status} → ${status}`);
  changed++;
}
console.log(`pull-status: ${changed} changed, ${same} unchanged, ${missing} not in local corpus`);
