// SQLite layer. Uses node:sqlite (built into Node 22) — no npm dependencies.
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// JOBHUNT_DB overrides the database path (tests use a throwaway file, never the real corpus).
const DB_PATH = process.env.JOBHUNT_DB ?? join(ROOT, 'data', 'jobs.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id              TEXT PRIMARY KEY,
  track           TEXT NOT NULL,
  title           TEXT NOT NULL,
  company         TEXT NOT NULL,
  location        TEXT,
  url             TEXT,
  sources         TEXT NOT NULL DEFAULT '[]',
  external_ids    TEXT NOT NULL DEFAULT '{}',
  category        TEXT,
  employment_type TEXT,
  remote          INTEGER DEFAULT 0,
  posted_at       TEXT,
  deadline        TEXT,
  pay_min         REAL,
  pay_max         REAL,
  pay_period      TEXT,
  hours_per_week  REAL,
  degrees         TEXT,
  terms           TEXT,
  description     TEXT,
  raw             TEXT,
  first_seen      TEXT NOT NULL,
  last_seen       TEXT NOT NULL,
  closed_at       TEXT,
  score           REAL,
  subscores       TEXT,
  rationale       TEXT,
  gap             TEXT,
  judged_hash     TEXT,
  status          TEXT NOT NULL DEFAULT 'new',
  status_updated  TEXT,
  pushed_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_track_score ON jobs(track, score DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_status      ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_last_seen   ON jobs(last_seen);

-- Quota ledger. The sweep refuses to exceed a budget rather than trusting itself.
CREATE TABLE IF NOT EXISTS api_usage (
  source TEXT NOT NULL,
  day    TEXT NOT NULL,
  calls  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (source, day)
);

CREATE TABLE IF NOT EXISTS runs (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  started  TEXT NOT NULL,
  finished TEXT,
  ok       INTEGER,
  summary  TEXT
);
`;

export function open() {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
}

// ── Dedupe ────────────────────────────────────────────────────────────────────
// Adzuna and Google-for-Jobs will surface the same posting, so the key has to be
// stable across sources: normalized company + title + location.

const COMPANY_NOISE = /\b(inc|llc|l\.l\.c|ltd|limited|corp|corporation|co|company|plc|gmbh|the)\b/g;

export function normCompany(s = '') {
  return String(s).toLowerCase().normalize('NFKD')
    .replace(/[^a-z0-9\s&]/g, ' ').replace(COMPANY_NOISE, ' ')
    .replace(/\s+/g, ' ').trim();
}

export function normTitle(s = '') {
  return String(s).toLowerCase().normalize('NFKD')
    .replace(/\(?\b(19|20)\d{2}\b\)?/g, ' ')                  // years
    .replace(/\b(req|requisition|job)\s*#?\s*\d+/g, ' ')       // req numbers
    .replace(/[^a-z0-9\s]/g, ' ')
    // Seasonal/qualifier noise. Sources disagree constantly here:
    // "SWE Intern" vs "SWE Intern (Summer 2027)" vs "SWE Intern - Summer".
    .replace(/\b(summer|fall|autumn|winter|spring)\b/g, ' ')
    .replace(/\b(multiple teams|all teams|various|general|new grad|university|campus)\b/g, ' ')
    .replace(/\b(intern|internship|interns|co op|coop|intern ship)\b/g, 'intern')
    .replace(/\b(sr|senior)\b/g, 'senior').replace(/\b(jr|junior)\b/g, 'junior')
    .replace(/\b(swe|sde)\b/g, 'software engineer')
    .replace(/\bengineering\b/g, 'engineer')
    .replace(/\bdeveloper\b/g, 'engineer')                      // "Software Developer" == "Software Engineer"
    .replace(/\s+/g, ' ').trim();
}

// Sources spell the same place many ways: "SF", "San Francisco, CA",
// "San Francisco, California, United States". Collapse to one token.
const CITY_ALIASES = new Map(Object.entries({
  sf: 'san francisco ca', sfo: 'san francisco ca', 'south san francisco': 'san francisco ca',
  'bay area': 'san francisco ca', 'silicon valley': 'san francisco ca',
  nyc: 'new york ny', 'new york city': 'new york ny', manhattan: 'new york ny',
  brooklyn: 'new york ny', 'nyc ny': 'new york ny',
  la: 'los angeles ca', 'l a': 'los angeles ca',
  sd: 'san diego ca', dc: 'washington dc', 'washington dc': 'washington dc',
  atx: 'austin tx', sea: 'seattle wa', chi: 'chicago il', bos: 'boston ma',
}));
const STATES = new Map(Object.entries({
  california: 'ca', 'new york': 'ny', texas: 'tx', washington: 'wa', massachusetts: 'ma',
  illinois: 'il', colorado: 'co', florida: 'fl', georgia: 'ga', virginia: 'va',
  pennsylvania: 'pa', ohio: 'oh', michigan: 'mi', oregon: 'or', arizona: 'az',
  'north carolina': 'nc', 'new jersey': 'nj', utah: 'ut', minnesota: 'mn',
}));

export function normLocation(s = '') {
  let t = String(s).toLowerCase();
  if (/\bremote\b|\banywhere\b|work\s?from\s?home|\bwfh\b/.test(t)) return 'remote';
  // Multi-location strings ("San Francisco, CA • New York, NY") — key on the first.
  t = t.split(/[•|;]|\s+or\s+|\s+\/\s+/)[0];
  t = t.replace(/\b(united states of america|united states|usa|u\.s\.a?\.?)\b/g, ' ')
       .replace(/[^a-z0-9\s]/g, ' ')
       .replace(/\s+\bus\b\s*$/, ' ')
       .replace(/\s+/g, ' ').trim();
  // full state name -> abbreviation, so "California" == "CA"
  for (const [full, ab] of STATES) {
    if (t === full) { t = ab; break; }
    if (t.endsWith(' ' + full)) { t = t.slice(0, -full.length) + ab; break; }
  }
  t = t.replace(/\s+/g, ' ').trim();
  // Whole-string alias first ("sf", "nyc"), then the city part of "city st".
  if (CITY_ALIASES.has(t)) return CITY_ALIASES.get(t);
  const m = t.match(/^(.*?)\s+([a-z]{2})$/);
  if (m) return CITY_ALIASES.get(m[1].trim()) ?? `${m[1].trim()} ${m[2]}`;
  return t;
}

export function jobId({ company, title, location }) {
  const key = `${normCompany(company)}|${normTitle(title)}|${normLocation(location)}`;
  return createHash('sha1').update(key).digest('hex').slice(0, 16);
}

// ── Upsert ────────────────────────────────────────────────────────────────────
// Never clobbers a richer value with a null one, and never resets status or score.

const MERGE_FIELDS = [
  'title','company','location','url','category','employment_type','remote',
  'posted_at','deadline','pay_min','pay_max','pay_period','hours_per_week',
  'degrees','terms','description','raw',
  'track', // classification can legitimately improve (e.g. correctTrack() catching a
           // co-op mislabeled by its source query) — a later, smarter sweep should be
           // able to fix an existing row, not just new ones.
];

export function upsert(db, job, sourceName) {
  const now = new Date().toISOString();
  const id = job.id ?? jobId(job);
  const existing = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);

  if (!existing) {
    db.prepare(`INSERT INTO jobs
      (id,track,title,company,location,url,sources,external_ids,category,employment_type,
       remote,posted_at,deadline,pay_min,pay_max,pay_period,hours_per_week,degrees,terms,
       description,raw,first_seen,last_seen)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, job.track, job.title, job.company, job.location ?? null, job.url ?? null,
      JSON.stringify([sourceName]),
      JSON.stringify(job.external_id ? { [sourceName]: job.external_id } : {}),
      job.category ?? null, job.employment_type ?? null, job.remote ? 1 : 0,
      job.posted_at ?? null, job.deadline ?? null,
      job.pay_min ?? null, job.pay_max ?? null, job.pay_period ?? null,
      job.hours_per_week ?? null,
      job.degrees ? JSON.stringify(job.degrees) : null,
      job.terms ? JSON.stringify(job.terms) : null,
      job.description ?? null, job.raw ? JSON.stringify(job.raw) : null,
      now, now,
    );
    return 'inserted';
  }

  // Merge: fill gaps, keep the richer description, union the source list.
  const sources = new Set(JSON.parse(existing.sources));
  sources.add(sourceName);
  const extIds = JSON.parse(existing.external_ids);
  if (job.external_id) extIds[sourceName] = job.external_id;

  const sets = [], vals = [];
  for (const f of MERGE_FIELDS) {
    let incoming = f === 'degrees' || f === 'terms'
      ? (job[f] ? JSON.stringify(job[f]) : null)
      : f === 'raw' ? (job.raw ? JSON.stringify(job.raw) : null)
      : f === 'remote' ? (job.remote ? 1 : 0)
      : job[f] ?? null;
    if (incoming === null || incoming === undefined) continue;
    // description: keep whichever is longer
    if (f === 'description' && existing.description &&
        String(existing.description).length >= String(incoming).length) continue;
    if (f === 'remote' && existing.remote === 1 && incoming === 0) continue;
    sets.push(`${f} = ?`); vals.push(incoming);
  }
  sets.push('sources = ?');      vals.push(JSON.stringify([...sources]));
  sets.push('external_ids = ?'); vals.push(JSON.stringify(extIds));
  sets.push('last_seen = ?');    vals.push(now);
  sets.push('closed_at = NULL');
  vals.push(id);
  db.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  return 'merged';
}

// Postings that vanish are marked closed, never deleted — history matters for
// "was this open last week?" and for not re-surfacing dead rows.
export function markClosed(db, sourceName, runStart) {
  const r = db.prepare(`UPDATE jobs SET closed_at = ?
     WHERE closed_at IS NULL AND last_seen < ? AND sources LIKE ?`)
    .run(new Date().toISOString(), runStart, `%"${sourceName}"%`);
  return r.changes;
}

// ── Quota ledger ──────────────────────────────────────────────────────────────
export function today() { return new Date().toISOString().slice(0, 10); }

export function callsToday(db, source) {
  const r = db.prepare('SELECT calls FROM api_usage WHERE source = ? AND day = ?')
    .get(source, today());
  return r?.calls ?? 0;
}

export function recordCall(db, source, n = 1) {
  db.prepare(`INSERT INTO api_usage (source, day, calls) VALUES (?,?,?)
    ON CONFLICT(source, day) DO UPDATE SET calls = calls + excluded.calls`)
    .run(source, today(), n);
}

export function callsSince(db, source, days) {
  const cutoff = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const r = db.prepare('SELECT COALESCE(SUM(calls),0) c FROM api_usage WHERE source = ? AND day >= ?')
    .get(source, cutoff);
  return r?.c ?? 0;
}
