#!/usr/bin/env node
// Sweep every configured source into data/jobs.db.
// Safe to run repeatedly: upserts by a source-stable dedupe key, marks vanished
// postings closed rather than deleting them, and refuses to exceed API budgets.

import { open, upsert, markClosed, jobId } from './lib/db.mjs';
import { loadEnv, loadSources, quotaGate, spend, getJSON, looksLikeIntern,
         looksLikeSummer2027, isRemote, firstLocation, inferCategory, correctTrack, bestApplyUrl } from './lib/util.mjs';

const env = loadEnv();
const cfg = loadSources();
const db = open();
const runStart = new Date().toISOString();
const only = process.argv.slice(2).filter(a => !a.startsWith('-'));
const log = (...a) => console.log(...a);
const stats = {};

function tally(source, res) {
  const s = stats[source] ??= { inserted: 0, merged: 0, skipped: 0, errors: 0 };
  if (res === 'inserted' || res === 'merged') s[res]++; else s.skipped++;
}
const want = n => only.length === 0 || only.includes(n);

// ── GitHub community internship lists ─────────────────────────────────────────
// The single highest-value source: ~2,233 active Summer 2027 postings in one GET.
async function sweepListings(name, c) {
  if (!quotaGate(db, name, c.budget_per_day, log)) return;
  log(`\n▶ ${name}: fetching listings.json …`);
  spend(db, name);
  const rows = await getJSON(c.url, { timeout: 120000 });
  if (!Array.isArray(rows)) throw new Error('expected a JSON array');
  log(`  ${rows.length} listings in feed`);

  let considered = 0;
  for (const j of rows) {
    if (c.require_active   && !j.active)     { tally(name, 'skip'); continue; }
    if (c.require_visible  && !j.is_visible) { tally(name, 'skip'); continue; }
    // Two schemas in the wild: Simplify uses `terms: ["Summer 2027"]`, vansh uses
    // `season: "Summer"` with no year — hence require_year_in_title for the latter.
    const terms = j.terms ?? (j.season ? [j.season] : []);
    const wanted = c.terms_wanted ?? c.season_wanted;
    if (wanted?.length &&
        !terms.some(t => wanted.some(w => String(t).includes(w)))) { tally(name,'skip'); continue; }
    if (c.require_year_in_title &&
        !new RegExp(String(c.require_year_in_title)).test(`${j.title} ${(j.terms??[]).join(' ')}`)) {
      tally(name, 'skip'); continue;
    }
    if (c.require_bachelors && Array.isArray(j.degrees) && j.degrees.length &&
        !j.degrees.some(d => /bachelor/i.test(d))) { tally(name, 'skip'); continue; }

    considered++;
    const loc = firstLocation(j.locations) ?? 'Unspecified';
    tally(name, upsert(db, {
      track: 'internship',
      title: j.title, company: j.company_name, location: loc,
      url: j.url, external_id: j.id, category: j.category,
      employment_type: 'Internship',
      remote: (j.locations ?? []).some(isRemote) ? 1 : 0,
      posted_at: j.date_posted ? new Date(j.date_posted * 1000).toISOString() : null,
      degrees: j.degrees, terms: j.terms,
      raw: { locations: j.locations, source: j.source, sponsorship: j.sponsorship },
    }, name));
  }
  log(`  ${considered} matched Summer 2027 + eligibility filters`);
}

// ── Adzuna: local part-time breadth ───────────────────────────────────────────
async function sweepAdzuna(c) {
  if (!env.ADZUNA_APP_ID || !env.ADZUNA_APP_KEY) {
    log('\n⏭  adzuna: no ADZUNA_APP_ID/KEY in .env — skipping (part-time coverage waits on this)');
    return;
  }
  log('\n▶ adzuna:');
  for (const q of c.queries) {
    for (let page = 1; page <= (c.max_pages ?? 1); page++) {
      if (!quotaGate(db, 'adzuna', c.budget_per_day, log)) return;
      const u = new URL(`https://api.adzuna.com/v1/api/jobs/${c.country}/search/${page}`);
      u.searchParams.set('app_id', env.ADZUNA_APP_ID);
      u.searchParams.set('app_key', env.ADZUNA_APP_KEY);
      // `what` = AND of every word; `what_or` = any-of (verified empirically — see
      // sources.yaml's comment on this). Pick whichever the query config set.
      if (q.what_or) u.searchParams.set('what_or', q.what_or);
      else u.searchParams.set('what', q.what);
      u.searchParams.set('where', c.where);
      u.searchParams.set('distance', String(c.distance_km ?? 32));
      u.searchParams.set('results_per_page', String(c.results_per_page ?? 50));
      // `part_time=1` is real (verified: narrows 338 vs a much larger unfiltered
      // count) but noisy — it still returned "Staff Engineer" and full-time-reading
      // titles, so Adzuna's own contract_time tagging isn't trustworthy alone.
      // Kept as a coarse pre-filter; score.mjs's employment_type gate is the real
      // backstop. (`full_time=0` was tested too and verified to change nothing —
      // dropped rather than shipped as a no-op.)
      u.searchParams.set('part_time', '1');
      u.searchParams.set('content-type', 'application/json');
      spend(db, 'adzuna');
      let d;
      try { d = await getJSON(u.toString()); }
      catch (e) { log(`  ✗ "${q.what ?? q.what_or}" p${page}: ${e.message}`); stats.adzuna = {...(stats.adzuna??{inserted:0,merged:0,skipped:0,errors:0})}; stats.adzuna.errors++; break; }
      const results = d.results ?? [];
      log(`  "${q.what ?? q.what_or}" p${page}: ${results.length} results`);
      for (const r of results) {
        const titleA = r.title?.replace(/<\/?[^>]+>/g, '') ?? 'Untitled';
        tally('adzuna', upsert(db, {
          track: correctTrack(q.track, titleA),
          title: titleA,
          company: r.company?.display_name ?? 'Unknown',
          location: r.location?.display_name ?? c.where,
          url: r.redirect_url, external_id: String(r.id),
          category: inferCategory(r.title ?? '', r.description ?? ''),
          raw: { adzuna_category: r.category?.label, salary_is_predicted: r.salary_is_predicted,
                 lat: r.latitude, lon: r.longitude },
          employment_type: r.contract_time ?? null,
          remote: isRemote(r.location?.display_name ?? '') ? 1 : 0,
          posted_at: r.created ?? null,
          // Adzuna fills salary_min/max with a MODEL ESTIMATE when the posting has no pay
          // (salary_is_predicted === '1'; 10 of 50 results in a live check). Showing those
          // as real pay, and scoring on them, was a bug — only trust posted salaries.
          pay_min: r.salary_is_predicted === '0' ? (r.salary_min ?? null) : null,
          pay_max: r.salary_is_predicted === '0' ? (r.salary_max ?? null) : null,
          pay_period: r.salary_is_predicted === '0' && r.salary_min ? 'year' : null,  // annual
          description: r.description?.replace(/<\/?[^>]+>/g, '') ?? null,
        }, 'adzuna'));
      }
      if (results.length < (c.results_per_page ?? 50)) break;
    }
  }
}

// ── SerpApi Google for Jobs: the ONLY route to Indeed + LinkedIn ───────────────
async function sweepSerpApi(c) {
  if (!env.SERPAPI_KEY) {
    log('\n⏭  serpapi: no SERPAPI_KEY in .env — skipping (this is the Indeed/LinkedIn route)');
    return;
  }
  log('\n▶ serpapi (Google for Jobs):');
  // Rotate by day-of-year so a week covers the set without blowing 250/month.
  const rot = c.query_rotation;
  const doy = Math.floor((Date.now() - Date.UTC(new Date().getUTCFullYear(), 0, 0)) / 864e5);
  const budget = c.budget_per_day ?? 5;
  const picks = Array.from({ length: Math.min(budget, rot.length) },
                           (_, i) => rot[(doy * budget + i) % rot.length]);
  const viaSeen = new Set();

  for (const q of picks) {
    if (!quotaGate(db, 'serpapi', budget, log)) return;
    const u = new URL('https://serpapi.com/search.json');
    u.searchParams.set('engine', 'google_jobs');
    u.searchParams.set('q', q.q);
    u.searchParams.set('location', c.location);
    u.searchParams.set('hl', 'en');   // locations came back in Arabic ("سان دييغو") without this
    u.searchParams.set('gl', 'us');
    u.searchParams.set('api_key', env.SERPAPI_KEY);
    spend(db, 'serpapi');
    let d;
    try { d = await getJSON(u.toString()); }
    catch (e) { log(`  ✗ "${q.q}": ${e.message}`); continue; }
    if (d.error) { log(`  ✗ "${q.q}": ${d.error}`); continue; }
    const results = d.jobs_results ?? [];
    log(`  "${q.q}": ${results.length} results`);
    for (const r of results) {
      if (r.via) viaSeen.add(String(r.via).replace(/^via\s+/i, ''));
      const ext = r.detected_extensions ?? {};
      tally('serpapi', upsert(db, {
        track: correctTrack(q.track, r.title ?? ''),
        title: r.title, company: r.company_name ?? 'Unknown',
        location: r.location ?? c.location,
        url: bestApplyUrl(r.company_name, r.apply_options, r.share_link ?? null),
        external_id: r.job_id ? String(r.job_id).slice(0, 64) : null,
        category: inferCategory(r.title ?? '', r.description ?? ''),
        employment_type: ext.schedule_type ?? null,
        remote: (ext.work_from_home || isRemote(r.location ?? '')) ? 1 : 0,
        description: r.description ?? null,
        raw: { via: r.via, apply_options: r.apply_options, extensions: r.detected_extensions },
      }, 'serpapi'));
    }
  }
  // Verification step 2 from the plan: prove Indeed and LinkedIn actually arrive.
  if (viaSeen.size) {
    const list = [...viaSeen].sort();
    log(`  sources seen via Google for Jobs: ${list.join(', ')}`);
    const hasLI = list.some(v => /linkedin/i.test(v));
    const hasIN = list.some(v => /indeed/i.test(v));
    log(`  LinkedIn present: ${hasLI ? 'YES ✓' : 'NO ✗'} | Indeed present: ${hasIN ? 'YES ✓' : 'NO ✗'}`);
    if (!hasLI && !hasIN) log('  ⚠ neither appeared — the Indeed/LinkedIn premise needs rework (see plan, Verification 2)');
  }
}

// ── Direct company boards ─────────────────────────────────────────────────────
async function sweepBoards(c) {
  const groups = [
    ['greenhouse', c.greenhouse ?? []],
    ['ashby',      c.ashby ?? []],
    ['lever',      c.lever ?? []],
  ];
  const total = groups.reduce((n, [, t]) => n + t.length, 0);
  if (!total) { log('\n⏭  boards: no verified tokens yet — run scripts/verify-boards.mjs'); return; }
  log('\n▶ boards:');
  for (const [kind, tokens] of groups) {
    for (const tok of tokens) {
      if (!quotaGate(db, 'boards', c.budget_per_day, log)) return;
      spend(db, 'boards');
      try {
        const jobs = await fetchBoard(kind, tok);
        let kept = 0;
        for (const j of jobs) {
          const blob = `${j.title} ${j.description ?? ''}`;
          if (!looksLikeIntern(j.title)) continue;
          if (!looksLikeSummer2027(blob)) continue;
          kept++;
          tally('boards', upsert(db, { ...j, track: 'internship', employment_type: 'Internship',
            category: inferCategory(j.title, j.description) }, 'boards'));
        }
        log(`  ${kind}/${tok}: ${jobs.length} open → ${kept} Summer-2027 intern roles`);
      } catch (e) { log(`  ✗ ${kind}/${tok}: ${e.message}`); }
    }
  }
}

async function fetchBoard(kind, tok) {
  if (kind === 'greenhouse') {
    const d = await getJSON(`https://boards-api.greenhouse.io/v1/boards/${tok}/jobs?content=true`);
    return (d.jobs ?? []).map(j => ({
      title: j.title, company: tok, location: j.location?.name ?? null,
      url: j.absolute_url, external_id: String(j.id),
      posted_at: j.updated_at ?? null,
      description: j.content ? String(j.content).replace(/<\/?[^>]+>/g, ' ').slice(0, 8000) : null,
      remote: isRemote(j.location?.name ?? '') ? 1 : 0,
    }));
  }
  if (kind === 'ashby') {
    const d = await getJSON(`https://api.ashbyhq.com/posting-api/job-board/${tok}`);
    return (d.jobs ?? []).map(j => ({
      title: j.title, company: tok, location: j.location ?? null,
      url: j.jobUrl ?? j.applyUrl, external_id: String(j.id),
      posted_at: j.publishedAt ?? null,
      description: j.descriptionPlain?.slice(0, 8000) ?? null,
      remote: j.isRemote ? 1 : (isRemote(j.location ?? '') ? 1 : 0),
    }));
  }
  const d = await getJSON(`https://api.lever.co/v0/postings/${tok}?mode=json`);
  if (!Array.isArray(d)) throw new Error(d?.error ?? 'unexpected response');
  return d.map(j => ({
    title: j.text, company: tok, location: j.categories?.location ?? null,
    url: j.hostedUrl, external_id: String(j.id),
    posted_at: j.createdAt ? new Date(j.createdAt).toISOString() : null,
    description: j.descriptionPlain?.slice(0, 8000) ?? null,
    remote: isRemote(j.categories?.location ?? '') ? 1 : 0,
  }));
}

// ── Main ──────────────────────────────────────────────────────────────────────
const runRow = db.prepare('INSERT INTO runs (started) VALUES (?)').run(runStart);
let ok = 1;
try {
  const tasks = [
    ['simplify', () => sweepListings('simplify', cfg.simplify)],
    ['vansh',    () => sweepListings('vansh',    cfg.vansh)],
    ['adzuna',   () => sweepAdzuna(cfg.adzuna)],
    ['serpapi',  () => sweepSerpApi(cfg.serpapi)],
    ['boards',   () => sweepBoards(cfg.boards)],
  ];
  for (const [name, fn] of tasks) {
    if (!cfg[name]?.enabled || !want(name)) continue;
    try { await fn(); }
    catch (e) { ok = 0; log(`  ✗ ${name} FAILED: ${e.message}`); (stats[name] ??= {inserted:0,merged:0,skipped:0,errors:0}).errors++; }
  }

  // Vanished postings → closed, not deleted.
  for (const name of Object.keys(stats)) {
    const n = markClosed(db, name, runStart);
    if (n) log(`\n  ${name}: ${n} postings no longer listed → marked closed`);
  }

  log('\n── summary ──────────────────────────────────');
  for (const [s, v] of Object.entries(stats))
    log(`  ${s.padEnd(10)} +${v.inserted} new, ${v.merged} merged, ${v.skipped} filtered, ${v.errors} errors`);
  const t = db.prepare(`SELECT track, COUNT(*) n FROM jobs WHERE closed_at IS NULL GROUP BY track`).all();
  log('  ' + (t.map(r => `${r.track}: ${r.n} open`).join(' | ') || 'no rows'));
  log(`  total rows: ${db.prepare('SELECT COUNT(*) n FROM jobs').get().n}`);
} catch (e) {
  ok = 0; console.error('FATAL', e);
} finally {
  db.prepare('UPDATE runs SET finished = ?, ok = ?, summary = ? WHERE id = ?')
    .run(new Date().toISOString(), ok, JSON.stringify(stats), runRow.lastInsertRowid);
}
process.exit(ok ? 0 : 1);
