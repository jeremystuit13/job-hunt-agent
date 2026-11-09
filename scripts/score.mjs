#!/usr/bin/env node
// Deterministic scoring pass. Runs after sweep.mjs.
//
// What this script does NOT do: read a job description and judge real fit against
// master.yaml — that needs actual language understanding, not string matching, and
// per the plan happens on the top slice (push time) or per-job at tailor time, where
// it's cheap because it's only ~70 jobs, not ~1,800. What's below is the honest
// deterministic floor: hard gates, then subscores from facts actually in the DB
// (company tier, category, timing, pay), composited by profile.yaml's weights.
//
// VERIFIED DURING BUILD: SimplifyJobs/vansh listings.json carries NO description
// field at all — title/company/locations/terms/degrees only. So `fit` for the vast
// majority of internship rows can only be category affinity, not keyword overlap;
// only board-sourced jobs (Greenhouse/Ashby/Lever) carry real description text.
// fit_method on each row's subscores records which one actually happened.

import { join } from 'node:path';
import { open, ROOT, normLocation } from './lib/db.mjs';
import { CATEGORY_AFFINITY } from './lib/util.mjs';
import { hourlyPay, milesFromHome, locationTier, SCHOOL_RE } from './lib/derive.mjs';
import { loadMaster, loadProfileConfig } from './lib/config.mjs';

const profile = loadProfileConfig();
const master = loadMaster();
const db = open();
const clamp = (n, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, n));

// ── Company tier (feeds `odds`) ────────────────────────────────────────────────
const tierSets = {
  elite: new Set((profile.company_tiers.elite ?? []).map(s => s.toLowerCase())),
  competitive: new Set((profile.company_tiers.competitive ?? []).map(s => s.toLowerCase())),
};
function tierOf(company = '') {
  const c = company.toLowerCase().trim();
  if (tierSets.elite.has(c)) return 'elite';
  if (tierSets.competitive.has(c)) return 'competitive';
  return 'standard';
}
const TIER_ODDS   = { elite: 0.22, competitive: 0.50, standard: 0.78 };
const TIER_BRAND  = { elite: 1.00, competitive: 0.72, standard: 0.48 };

// ── Timing ──────────────────────────────────────────────────────────────────────
function daysSince(iso) {
  if (!iso) return null;
  const d = (Date.now() - new Date(iso).getTime()) / 864e5;
  return Number.isFinite(d) ? d : null;
}
function recencyFactor(postedAt) {
  const d = daysSince(postedAt);
  if (d === null) return 0.5; // unknown, neutral
  if (d < 7) return 1.0; if (d < 30) return 0.85; if (d < 90) return 0.65;
  return 0.45;
}
function urgencyFactor(deadline, postedAt) {
  if (deadline) {
    const d = (new Date(deadline).getTime() - Date.now()) / 864e5;
    if (!Number.isFinite(d)) return 0.4;
    if (d < 0) return 0;                       // already past — shouldn't be pushed
    return clamp(1 - d / 45);
  }
  // No stated deadline (the common case for these sources): treat staleness as a
  // weak proxy — an older unfilled posting is more likely to close soon, not less.
  const d = daysSince(postedAt);
  return d === null ? 0.35 : clamp(1 - d / 60, 0.1, 0.7);
}

// ── Fit proxy ─────────────────────────────────────────────────────────────────
const MASTER_TAGS = new Set();
(function collectTags(o) {
  if (Array.isArray(o)) return o.forEach(collectTags);
  if (o && typeof o === 'object') {
    if (Array.isArray(o.tags)) o.tags.forEach(t => MASTER_TAGS.add(String(t).toLowerCase()));
    for (const v of Object.values(o)) collectTags(v);
  }
})(master);
// Tags that describe the *shape* of experience rather than a skill. They match boilerplate in
// nearly every posting ("internship", "training" in the benefits section, "teaching", "leadership")
// — verified 2026-11-04 when DoorDash's rationale read "JD matches internship, training, teaching"
// with a perfect fit score. They stay in master.yaml for tailoring; they just can't count as fit.
const GENERIC_TAGS = new Set(['internship', 'training', 'teaching', 'communication', 'leadership',
  'teamwork', 'mentoring', 'coaching', 'presenting', 'public-speaking', 'customer-service',
  'guest-services', 'student-org', 'outreach', 'team-building', 'recruitment', 'documentation',
  'design', 'time-management', 'initiative', 'industry-exposure', 'instruction', 'multilingual',
  'physical-work', 'manual-labor', 'self-employment', 'business-process', 'sales-support',
  'stakeholder-communication', 'stakeholder-management', 'cross-team-collaboration',
  'workshop-facilitation', 'tutoring', 'configuration', 'correctness', 'edge-cases']);
// A few synonyms so "REST API" in a JD matches the `rest-api` tag, etc.
const TAG_PATTERNS = [...MASTER_TAGS].filter(t => !GENERIC_TAGS.has(t)).map(tag => ({
  tag, re: new RegExp('\\b' + tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/-/g, '[- ]?') + 's?\\b', 'i'),   // s?: "deployments" must match `deployment`
}));

function fitScore(job) {
  const cat = job.category ?? 'Other';
  const catAffinity = CATEGORY_AFFINITY[cat] ?? CATEGORY_AFFINITY.Other;
  if (!job.description || job.description.length < 40) {
    return { fit: catAffinity, fit_method: 'category_only' };
  }
  const text = job.description.toLowerCase();
  const hits = TAG_PATTERNS.filter(p => p.re.test(text)).map(p => p.tag);
  const overlap = clamp(hits.length / 6);           // 6+ tag matches = strong signal
  return { fit: clamp(0.4 * catAffinity + 0.6 * overlap), fit_method: 'keyword_overlap', matched_tags: hits };
}

// ── Location (M12) ─────────────────────────────────────────────────────────────
// California first: a real weighted subscore (profile.yaml weights.internship.location), replacing
// the old +0.06 San Diego bonus that left the top of the board with no San Diego jobs at all.
const LOC_SCORE = profile.location_tiers ?? { sd: 1, bay: 1, ca: 0.7, remote: 0.6, us: 0.3 };
const REGION_PHRASE = { sd: 'in the San Diego area', bay: 'in the Bay Area', ca: 'in California',
                        remote: 'remote', us: null, nonus: 'outside the US' };

// ── Internship scoring ───────────────────────────────────────────────────────────
function scoreInternship(job) {
  const tier = tierOf(job.company);
  const odds = clamp(0.5 * TIER_ODDS[tier] + 0.3 * profile.candidate.profile_strength
                      + 0.2 * recencyFactor(job.posted_at));
  const catAffinity = CATEGORY_AFFINITY[job.category ?? 'Other'] ?? CATEGORY_AFFINITY.Other;
  const resume_value = clamp(0.7 * catAffinity + 0.3 * TIER_BRAND[tier]);
  const { fit, fit_method, matched_tags } = fitScore(job);
  const urgency = urgencyFactor(job.deadline, job.posted_at);
  const region = locationTier(job);
  const location = LOC_SCORE[region] ?? LOC_SCORE.us;
  const w = profile.weights.internship;
  const composite = clamp(w.odds * odds + w.resume_value * resume_value + w.fit * fit
                          + w.urgency * urgency + (w.location ?? 0) * location);

  const bits = [];
  const where = REGION_PHRASE[region];
  bits.push(`${tier === 'standard' ? 'A less-selective' : `${/^[aeiou]/i.test(tier) ? 'An' : 'A'} ${tier}`} ${job.category ?? 'tech'} role at ${job.company}${where ? ' ' + where : ''}`);
  if (fit_method === 'keyword_overlap' && matched_tags?.length) bits.push(`JD matches ${matched_tags.slice(0,3).join(', ')}`);
  else bits.push('no JD text from this source to match against your background yet');
  if (urgency > 0.6) bits.push('and it looks time-sensitive');
  const rationale = bits.join(' — ') + '.';
  const gap = fit_method === 'category_only'
    ? 'Source gives no job description — real fit/gap needs the tailor pass on the actual posting.'
    : (matched_tags?.length ? null : 'No overlap found with your current skill tags — worth a manual read before applying.');

  return { score: composite, subscores: { odds, resume_value, fit, urgency, location, fit_method }, rationale, gap };
}

// ── Part-time scoring (with hard gates) ───────────────────────────────────────────
// "On-campus" only earns the student-friendly bonus when the ROLE reads as student work.
// A university also posts faculty/staff jobs ("Clinical Scholar Pool", ~$110K/yr) that are not
// hours-around-class jobs for a student — the employer alone isn't enough.
const STUDENT_ROLE_RE = /\b(student|assistant|tutor|aide|peer|intern|ambassador|grader|reader|mentor|lab tech)\b/i;
// Roles that are student work BY DESIGN at any employer (not just the candidate's school): the title itself
// says so. Deliberately excludes bare "assistant"/"aide" — "Executive Assistant" and
// "Medical Assistant" aren't student-shaped.
const STUDENT_FRIENDLY_RE = /\b(student|tutor|peer|ambassador|grader|reader|mentor|work[- ]study|research assistant|teaching assistant|lab assistant)\b/i;
const studentFriendly = job => STUDENT_FRIENDLY_RE.test(job.title ?? '');
function onCampus(job) {
  return SCHOOL_RE.test(job.company ?? '') && STUDENT_ROLE_RE.test(job.title ?? '');
}
// ~0.7 mi per commute-minute in mixed San Diego traffic (30 min ≈ 21 mi).
const MAX_MILES = () => profile.logistics.max_commute_minutes * 0.7;
// Fallback when there are no coordinates (SerpApi rows): San Diego County place names.
const SD_AREA_RE = /san diego|la jolla|national city|chula vista|coronado|imperial beach|la mesa|el cajon|santee|lemon grove|spring valley|poway|rancho bernardo|mira mesa|del mar|solana beach|encinitas|carlsbad|oceanside|escondido|san marcos|vista\b|lakeside|bonita|sorrento valley|kearny mesa|clairemont|pacific beach|point loma|سان دييغو/i;
function inCommuteArea(job) {
  const loc = normLocation(job.location ?? '');
  if (job.remote || loc === 'remote') return { ok: true, miles: null };
  const miles = milesFromHome(job);
  if (miles != null) return { ok: miles <= MAX_MILES(), miles };
  return { ok: SD_AREA_RE.test(job.location ?? ''), miles: null };
}

// Adzuna's own contract_time tagging is unreliable — verified directly against the
// live API that it labels "Staff Engineer, Integration" and "Senior Program Manager"
// postings as "part_time". So employment_type alone can't be trusted; seniority
// language in the TITLE is a far more reliable signal that a role needs years of
// experience and isn't hours-around-class work, regardless of how the source tagged it.
const SENIORITY_TITLE_RE = /\b(staff|senior|sr\.?|principal|director|vp\b|vice president|head of|chief|lead\b|manager)\b/i;

function gateParttime(job) {
  const area = inCommuteArea(job);
  if (!area.ok) return area.miles != null
    ? `~${area.miles.toFixed(0)} mi from home — beyond your ~${MAX_MILES().toFixed(0)} mi commute`
    : 'outside commute radius (not San Diego area or remote)';
  if (/full[\s-]?time/i.test(job.employment_type ?? '')) return 'listed as full-time, not part-time';
  if (SENIORITY_TITLE_RE.test(job.title))
    return 'title reads as a senior/full-time career role (source mistagged it "part-time")';
  const hourly = hourlyPay(job);
  // Too HIGH is a mismatch signal: posted pay annualizing above ~$50/hr (~$104K/yr) is a
  // full-time professional salary. Too LOW is deliberately NOT a gate any more — it only ever
  // fired on unit/data glitches — low pay just scores lower via pay_hours.
  if (hourly != null && hourly > 50) return `posted pay (~$${hourly.toFixed(0)}/hr annualized) reads as a full-time professional salary`;
  return null;
}
function scoreParttime(job) {
  const cat = job.category ?? 'Other';
  const loc = normLocation(job.location ?? '');
  const remote = job.remote || loc === 'remote';

  const hourly = hourlyPay(job);
  const pay_hours = hourly ? clamp((hourly - 10) / 20) : 0.5; // $10/hr→0, $30/hr→1; unknown = neutral

  const rankIdx = (profile.preferences.parttime_role_types_ranked ?? []).indexOf(cat);
  const typeAffinity = studentFriendly(job) || onCampus(job) ? 0.9
    : rankIdx >= 0 ? clamp(1 - rankIdx * 0.15)
    : CATEGORY_AFFINITY[cat] ?? CATEGORY_AFFINITY.Other;
  const resume_value = typeAffinity;

  const odds = studentFriendly(job) || onCampus(job) ? 0.85 : tierOf(job.company) === 'standard' ? 0.65 : 0.35;
  const miles = milesFromHome(job);
  const commute = remote ? 1.0
    : miles != null ? clamp(1 - miles / (MAX_MILES() * 1.25), 0.15, 0.98)   // nearer = better
    : inCommuteArea(job).ok ? 0.6 : 0.1;                                    // no coordinates: neutral

  const w = profile.weights.parttime;
  const composite = clamp(w.pay_hours * pay_hours + w.resume_value * resume_value
                         + w.odds * odds + w.commute * commute);

  const bits = [onCampus(job) ? 'On-campus student role' : studentFriendly(job) ? `Student-friendly role at ${job.company}` : `${job.category ?? 'Local'} role at ${job.company}`];
  bits.push(hourly ? `~$${hourly.toFixed(2)}/hr` : 'pay not listed');
  bits.push(remote ? 'remote' : miles != null ? `~${miles.toFixed(0)} mi away` : inCommuteArea(job).ok ? 'in the San Diego area' : loc || 'location unclear');
  return { score: composite, subscores: { pay_hours, resume_value, odds, commute },
           rationale: bits.join(', ') + '.', gap: null };
}

// ── Run ───────────────────────────────────────────────────────────────────────
const rows = db.prepare('SELECT * FROM jobs WHERE closed_at IS NULL').all();
let scored = 0, gated = 0;
const upd = db.prepare(`UPDATE jobs SET score=?, subscores=?, rationale=?, gap=?, status=?
  WHERE id=? AND status IN ('new','gated')`);
// Rows a human has acted on keep their STATUS — but their numbers still refresh. Skipping them
// entirely (the old behavior) froze a starred/applied job's score and rationale forever, so
// scoring fixes never reached the jobs the user cares about most (found 2026-11-04: DoorDash, queued
// for tailoring, still read "A elite ... JD matches internship, training, teaching" after the fix).
// A gated job he acted on isn't re-gated either — his decision wins over the gate.
const preserveStatuses = new Set(['shortlisted','tailoring','ready','applied','interview','offer','rejected','dismissed']);
const updNumbersOnly = db.prepare(`UPDATE jobs SET score=?, subscores=?, rationale=?, gap=? WHERE id=?`);

for (const job of rows) {
  if (preserveStatuses.has(job.status)) {
    const r = job.track === 'parttime' ? scoreParttime(job) : scoreInternship(job);
    updNumbersOnly.run(r.score, JSON.stringify(r.subscores), r.rationale, r.gap, job.id);
    scored++;
    continue;
  }
  if (job.track === 'parttime') {
    const gateReason = gateParttime(job);
    if (gateReason) {
      upd.run(null, JSON.stringify({ gated: gateReason }), gateReason, null, 'gated', job.id);
      gated++; continue;
    }
    const r = scoreParttime(job);
    upd.run(r.score, JSON.stringify(r.subscores), r.rationale, r.gap, 'new', job.id);
    scored++;
  } else {
    // US-only search: a posting whose every listed location is outside the US is out of scope
    // (243 of them came in via SimplifyJobs' list on 2026-11-04 — Canada, UK, India…).
    if (locationTier(job) === 'nonus') {
      upd.run(null, JSON.stringify({ gated: 'outside the US' }), 'Outside the US — your search is US-only.', null, 'gated', job.id);
      gated++; continue;
    }
    const r = scoreInternship(job);
    upd.run(r.score, JSON.stringify(r.subscores), r.rationale, r.gap, 'new', job.id);
    scored++;
  }
}
console.log(`scored ${scored} jobs, gated out ${gated} (part-time commute/pay/type gates + internships outside the US)`);

for (const track of ['internship', 'parttime']) {
  const top = db.prepare(`SELECT title, company, location, score, rationale FROM jobs
    WHERE track=? AND closed_at IS NULL AND score IS NOT NULL ORDER BY score DESC LIMIT 10`).all(track);
  console.log(`\n── top 10 ${track} ──`);
  top.forEach((j, i) => console.log(`  ${String(i+1).padStart(2)}. ${j.score.toFixed(3)}  ${j.title.slice(0,45).padEnd(45)} @ ${j.company.slice(0,20).padEnd(20)} (${j.location ?? '?'})`));
}
