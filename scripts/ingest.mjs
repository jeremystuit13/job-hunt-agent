#!/usr/bin/env node
// Generic ingest: read a JSON array of postings on stdin and upsert them (used by the
// Handshake skill, whose rows come from a browser session rather than an API adapter).
// Each row: { title, company, location, url, track?, employment_type?, description?,
//             posted_at?, deadline?, pay_min?, pay_max?, pay_period?, remote?, external_id? }
// Usage: cat rows.json | node scripts/ingest.mjs <source-name> [--track parttime|internship]
import { open, upsert } from './lib/db.mjs';
import { inferCategory, correctTrack, isRemote } from './lib/util.mjs';

const source = process.argv[2];
if (!source) { console.error('usage: ingest.mjs <source> [--track t]'); process.exit(1); }
const ti = process.argv.indexOf('--track');
const defaultTrack = ti > -1 ? process.argv[ti + 1] : 'parttime';
let raw = ''; for await (const c of process.stdin) raw += c;
const rows = JSON.parse(raw);
if (!Array.isArray(rows)) { console.error('stdin must be a JSON array'); process.exit(1); }

const db = open(); const t = { inserted: 0, merged: 0, bad: 0 };
for (const r of rows) {
  if (!r.title || !r.company) { t.bad++; continue; }
  const track = correctTrack(r.track ?? defaultTrack, r.title);
  const res = upsert(db, {
    ...r, track,
    category: r.category ?? inferCategory(r.title, r.description ?? ''),
    remote: r.remote ?? (isRemote(r.location ?? '') ? 1 : 0),
  }, source);
  t[res]++;
}
console.log(`ingest(${source}): +${t.inserted} new, ${t.merged} merged, ${t.bad} skipped (missing title/company)`);
