import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { ROOT, callsToday, callsSince, recordCall } from './db.mjs';
import { loadProfileConfig } from './config.mjs';

export function loadEnv() {
  const p = join(ROOT, '.env');
  const env = {};
  if (!existsSync(p)) return env;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m && m[2].trim()) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return env;
}

export function loadSources() {
  return YAML.parse(readFileSync(join(ROOT, 'sources.yaml'), 'utf8'));
}

export function loadProfile() {
  try { return loadProfileConfig(); } catch { return null; }
}

// Hard quota stop. Returns false and logs rather than overspending an allowance.
export function quotaGate(db, source, budget, log) {
  const used = callsToday(db, source);
  if (used >= budget) {
    log(`  ⏸  ${source}: daily budget spent (${used}/${budget}) — declining to call`);
    return false;
  }
  return true;
}

export function spend(db, source, n = 1) { recordCall(db, source, n); }
export { callsToday, callsSince };

export async function getJSON(url, { headers = {}, timeout = 60000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, {
      signal: ctl.signal,
      headers: { 'User-Agent': 'jobhunt/1.0 (personal job search)', ...headers },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

export const SUMMER_2027 = 'Summer 2027';

// Does this title look like an internship rather than a full-time role?
export function looksLikeIntern(title = '') {
  return /\b(intern|internship|co-?op|summer\s+analyst|summer\s+associate)\b/i.test(title);
}

// Adzuna/SerpApi queries are tagged parttime/internship by QUERY, not by result — a
// "part-time"-tagged query on Adzuna still returns "Electrical Engineering Co-op" and
// "Part-Time Internship" postings (verified in a real sweep). Those are internship-
// program work, not the hours-around-class job the user meant by "part-time", so
// reclassify on the result's own title rather than trust the query's declared track.
export function correctTrack(declaredTrack, title = '') {
  if (declaredTrack === 'parttime' && looksLikeIntern(title)) return 'internship';
  return declaredTrack;
}

// Google for Jobs (SerpApi) gives a `share_link` that is a Google *search results page*, plus
// an `apply_options` list. Verified on real rows: the list is NOISY — DoorDash's included links to
// Persona AI, Brain Corp and Astranis jobs; BAE's Monster link was a different (Hardware) role.
// So never take apply_options[0] blindly: take the option published by the employer itself
// (matched by option title or by the company name appearing in the link's host). If none
// matches, keep the Google panel — it at least shows the right job.
const squash = s => String(s ?? '').toLowerCase().replace(/\b(inc|llc|ltd|corp|corporation|co|company|the)\b/g, '').replace(/[^a-z0-9]/g, '');
export function bestApplyUrl(company, applyOptions, fallback) {
  const co = squash(company);
  if (co.length >= 3 && Array.isArray(applyOptions)) {
    for (const o of applyOptions) {
      if (!o?.link) continue;
      let host = '';
      try { host = new URL(o.link).hostname.replace(/[^a-z0-9]/gi, '').toLowerCase(); } catch { continue; }
      const t = squash(o.title);
      // (not `co.includes(t)`: a short aggregator title like "Dice" would false-match "Paradice")
      if ((t && (t === co || t.includes(co))) || host.includes(co)) {
        try {           // drop tracking params; the page is identical without them
          const u = new URL(o.link);
          for (const k of [...u.searchParams.keys()]) if (/^utm_/i.test(k)) u.searchParams.delete(k);
          return u.toString();
        } catch { return o.link; }
      }
    }
    // Second tier: a well-known aggregator, but ONLY when the company's name is in the URL path
    // (e.g. ziprecruiter.com/c/Russian-School-of-Mathematics/...) — verifiable, so it can't be
    // the "different company's job" noise above. Indeed's ?jk= links carry no name, so they
    // can never be verified this way and never pass.
    const TRUSTED = /(^|\.)(linkedin|indeed|ziprecruiter|builtin|glassdoor|wellfound)\.com$/i;
    for (const o of applyOptions) {
      if (!o?.link) continue;
      let u; try { u = new URL(o.link); } catch { continue; }
      if (!TRUSTED.test(u.hostname)) continue;
      if (decodeURIComponent(u.pathname).toLowerCase().replace(/[^a-z0-9]/g, '').includes(co)) {
        for (const k of [...u.searchParams.keys()]) if (/^utm_/i.test(k)) u.searchParams.delete(k);
        return u.toString();
      }
    }
  }
  return fallback ?? null;
}

// Is this posting plausibly for the Summer 2027 cycle?
export function looksLikeSummer2027(text = '') {
  return /summer\s*'?2027|2027\s*summer|\b2027\b/i.test(text);
}

export function isRemote(s = '') {
  return /\bremote\b|\banywhere\b|work\s?from\s?home|\bwfh\b/i.test(s);
}

export function firstLocation(locs) {
  if (!locs) return null;
  if (Array.isArray(locs)) return locs[0] ?? null;
  return String(locs);
}

// Company boards hand back every intern role they have — Accounting, Brokerage Ops,
// Brand Design. Simplify pre-tags a `category`; boards don't, so infer one here or
// scoring has nothing to discriminate on for a CS student.
const CATEGORY_RULES = [
  ['Software',    /\b(software|swe|sde|backend|back-end|frontend|front-end|full-?stack|web|mobile|ios|android|platform|infrastructure|systems?|devops|sre|security engineer|compiler|embedded software)\b/i],
  ['AI/ML/Data',  /\b(machine learning|\bml\b|\bai\b|data scien|data engineer|data analy|analytics|research scientist|deep learning|nlp|computer vision|quantitative research)\b/i],
  ['Quant',       /\b(quant|quantitative trad|trading|trader|algorithmic)\b/i],
  ['Hardware',    /\b(hardware|electrical|asic|fpga|silicon|chip|firmware|mechanical|rf engineer|pcb)\b/i],
  ['IT/Support',  /\b(it support|help ?desk|technical support|desktop support|sysadmin|system administrat)\b/i],
  ['Product',     /\b(product manage|product design|\bpm\b|ux|user experience|program manage|technical program)\b/i],
  ['Design',      /\b(design|brand|graphic|visual|creative)\b/i],
  ['Business',    /\b(account|financ|audit|tax|brokerage|operations|ops|risk|compliance|fraud|sales|marketing|recruit|people|hr\b|legal|strategy|business analyst|consult|supply chain|logistics)\b/i],
];

export function inferCategory(title = '', description = '') {
  // Title first. Blending in description text mislabels badly: generic words like "system"
  // or "platform" appear in nearly any corporate description (an accountancy scholar pool
  // and a mobile-examiner sales rep both came out as "Software"). Description is only a
  // fallback when the title gives no signal at all.
  for (const [cat, re] of CATEGORY_RULES) if (re.test(title)) return cat;
  const desc = String(description).slice(0, 600);
  for (const [cat, re] of CATEGORY_RULES) if (re.test(desc)) return cat;
  return 'Other';
}

// How relevant is a category to a CS undergrad? Feeds the scoring pass; it is a
// preference weight, never a hard filter (the user asked for a wide net).
export const CATEGORY_AFFINITY = {
  'Software': 1.00, 'AI/ML/Data': 0.92, 'Quant': 0.80, 'IT/Support': 0.70,
  'Product': 0.55, 'Hardware': 0.45, 'Design': 0.20, 'Business': 0.15, 'Other': 0.35,
};
