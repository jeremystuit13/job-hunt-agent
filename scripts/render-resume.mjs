#!/usr/bin/env node
// Builds a tailored application package for ONE job: resume.pdf, trace.json,
// cover.md, cover.pdf (only when complete), answers.md, answers.json, apply.url — written to
// applications/<job-id>/.
//
// Selection, never invention: every rendered résumé line is chosen from
// resume/master.yaml and must carry that bullet's id in trace.json. The build
// throws (does not silently drop the line) if any rendered line has no id —
// that's the mechanism, not a promise, per the plan's résumé pipeline section.
//
// Usage: node scripts/render-resume.mjs <job-id> [--test-guardrail]

import { readFileSync, writeFileSync, mkdirSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { open, ROOT } from './lib/db.mjs';
import { loadMaster, loadProfileConfig } from './lib/config.mjs';

const jobId = process.argv[2];
const testGuardrail = process.argv.includes('--test-guardrail');
if (!jobId) { console.error('usage: render-resume.mjs <job-id>'); process.exit(1); }

const master = loadMaster();
const db = open();
const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
if (!job) { console.error(`no job with id ${jobId} in data/jobs.db`); process.exit(1); }

// ── Collect every legitimate bullet id, so the guardrail has something real to check against ──
const BULLET_IDS = new Set();
(function walk(o) {
  if (Array.isArray(o)) return o.forEach(walk);
  if (o && typeof o === 'object') {
    if (Array.isArray(o.bullets)) o.bullets.forEach(b => BULLET_IDS.add(b.id));
    for (const v of Object.values(o)) walk(v);
  }
})(master);

const TRACE = [];      // { html, sourceId } for every rendered claim line
function claim(sourceId, html) {
  if (testGuardrail && sourceId === 'INJECTED_FAKE_ID') { /* deliberately bad, see below */ }
  TRACE.push({ sourceId, html });
  return html;
}
function verifyTrace() {
  const bad = TRACE.filter(t => !BULLET_IDS.has(t.sourceId));
  if (bad.length) {
    throw new Error(`GUARDRAIL: ${bad.length} rendered line(s) have no matching bullet id in master.yaml: ` +
      bad.map(b => `[${b.sourceId}] "${b.html.slice(0,60)}..."`).join('; '));
  }
}

// ── Pick a variant for a bullet given the job's category ──────────────────────
// `variantOverride` (from selection.json, M9) wins when present — it's chosen after actually
// reading the real JD, which is strictly better signal than the category-only fallback below.
function pickVariant(bullet, category, variantOverride) {
  const catToVariant = { Software: 'backend', 'AI/ML/Data': 'data', Quant: 'data' };
  const preferred = variantOverride || catToVariant[category];
  if (preferred && bullet.variants?.[preferred]) return bullet.variants[preferred];
  return bullet.text;
}
function claimCover(bullet) { return pickVariant(bullet, job.category, variantOverride); }
function findById(id) {
  let found = null;
  (function walk(o) {
    if (found || !o) return;
    if (Array.isArray(o)) return o.forEach(walk);
    if (typeof o === 'object') {
      if (Array.isArray(o.bullets)) { const b = o.bullets.find(x => x.id === id); if (b) { found = b; return; } }
      for (const v of Object.values(o)) walk(v);
    }
  })(master);
  return found;
}
function esc(s) { return String(s ?? '').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }

// "2028-05" -> "May 2028", with no Date object involved — `new Date("2028-05")` parses as
// UTC midnight, and formatting that in a negative-UTC-offset timezone (e.g. Pacific) rolls
// it back a day into the previous month, silently printing "April 2028" on a May grad date.
const MONTHS = ['January','February','March','April','May','June','July','August',
                'September','October','November','December'];
function monthYear(yyyymm) {
  const m = String(yyyymm).match(/^(\d{4})-(\d{2})/);
  if (!m) return String(yyyymm);
  return `${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

// ── M9: JD-matched override ────────────────────────────────────────────────────
// Optional per-job file, written by the jobs-tailor skill AFTER it actually reads the real
// posting and matches its requirements against master.yaml's bullet `tags` — real signal, not
// the category-only guess below. Schema: { experiencePicks, projectPicks, variantPreference }.
// Absent (the common case — most sources carry no JD text) => today's exact logic, unchanged.
const selectionPath = join(ROOT, 'applications', jobId, 'selection.json');
let SELECTION = null;
if (existsSync(selectionPath)) {
  try {
    const s = JSON.parse(readFileSync(selectionPath, 'utf8'));
    if (Array.isArray(s.experiencePicks) || Array.isArray(s.projectPicks)) SELECTION = s;
  } catch (e) {
    console.error(`  ⚠ selection.json present but unreadable (${e.message}) — falling back to category logic`);
  }
}
const variantOverride = SELECTION?.variantPreference ?? null;

// ── Section selection (deterministic, category-driven; see plan: this is
// SELECTION among pre-authored variants, not on-the-fly wording invention) ──
const isTechCategory = ['Software', 'AI/ML/Data', 'Quant'].includes(job.category);
const track = job.track;

const experiencePicks = []; // [{ orgLine, dateLine, bulletIds: [] }]
const projectPicks = [];

const isTechyPartTime = ['IT/Support', 'Software', 'AI/ML/Data'].includes(job.category);

if (SELECTION) {
  experiencePicks.push(...(SELECTION.experiencePicks ?? []));
  projectPicks.push(...(SELECTION.projectPicks ?? []));
} else {
  // Category fallback: the candidate's default one-page layouts live in master.yaml (`layouts`),
  // not in code, so the renderer works for any candidate. Three layouts: `internship` (also used for
  // any tech-category job), `parttime_tech`, `parttime`. An entry may carry `only_if: tutoring` to
  // appear only for IT/Support or tutoring/teaching roles.
  const L = master.layouts ?? {};
  const key = (track === 'internship' || isTechCategory) ? 'internship'
    : (track === 'parttime' && isTechyPartTime) ? 'parttime_tech' : 'parttime';
  const layout = L[key];
  if (!layout) throw new Error(`master.yaml has no layouts.${key} — see resume/master.example.yaml`);
  const tutoring = job.category === 'IT/Support' || /tutor|teach/i.test(job.title);
  const keep = e => e.only_if !== 'tutoring' || tutoring;
  experiencePicks.push(...(layout.experience ?? []).filter(keep));
  projectPicks.push(...(layout.projects ?? []).filter(keep));
}

function renderPicks(picks) {
  return picks.map(p => {
    // A bulletIds entry is either "kt-1" or { id: "kt-2", variant: "devops" } — the object form
    // lets a JD-matched selection give each bullet its own phrasing (one global variantPreference
    // can't give kt-2 its devops wording while kt-1 keeps backend). The id is what the guardrail
    // checks either way; a variant is only ever alternate wording of that same verified fact.
    const lis = p.bulletIds.map(entry => {
      const id = typeof entry === 'string' ? entry : entry?.id;
      const b = findById(id);
      if (!b) throw new Error(`bullet id "${id}" not found in master.yaml`);
      let text;
      const want = typeof entry === 'object' ? entry.variant : null;
      if (want === 'default') text = b.text;                    // explicit: the plain base wording
      else if (want && b.variants?.[want]) text = b.variants[want];
      else {
        if (want) console.error(`  ⚠ ${id} has no "${want}" variant — using default selection`);
        text = pickVariant(b, job.category, variantOverride);
      }
      return `<li>${claim(id, esc(text))}</li>`;
    }).join('\n      ');
    return `  <div class="entry">
    <div class="entry-head"><span>${esc(p.org)}</span><span>${esc(p.dates)}</span></div>
    <div class="entry-sub"><span>${esc(p.sub)}</span></div>
    <ul>\n      ${lis}\n    </ul>
  </div>`;
  }).join('\n');
}

const experienceHTML = renderPicks(experiencePicks);
const projectsHTML = projectPicks.length
  ? `<h2>Projects</h2>\n${renderPicks(projectPicks)}` : '';

// ── Education (facts, not claims — traced separately, not through the bullet guardrail) ──
// Facts only — no accomplishment bullet here. Rugby leadership now renders as
// its own Experience entry (exp-rugby), matching how the docx source structures it.
const edu = master.education.find(e => e.primary) ?? master.education[0];
const educationHTML = `  <div class="entry">
    <div class="entry-head"><span>${esc(edu.school)}</span><span>Expected ${esc(monthYear(edu.expected_grad))}</span></div>
    <div class="entry-sub"><span>${esc(edu.degree)}${edu.gpa && edu.gpa !== null ? ' · GPA ' + edu.gpa : ''}</span></div>
  </div>`;

// ── Summary ──────────────────────────────────────────────────────────────────
const summaryEntry = master.summary_variants.find(s => s.track === (isTechCategory || track === 'internship' ? 'internship' : 'parttime'));

// ── Skills — facts, not claims (a listed tool/language, not an accomplishment) ──
const skillLines = [];
if (master.skills.languages_programming.length)
  skillLines.push(`<div class="skills-line"><b>Languages:</b> ${master.skills.languages_programming.map(s=>esc(s.name)).join(', ')}</div>`);
if (master.skills.tools.length)
  skillLines.push(`<div class="skills-line"><b>Tools:</b> ${master.skills.tools.map(s=>esc(s.name)).join(', ')}</div>`);
if (master.skills.spoken_languages.length)
  // Show a qualifier for anything less than fluent — a plain, unqualified language name
  // on a résumé reads as fluent, and Chinese's real self-rating (elementary) shouldn't
  // be silently rounded up to that.
  skillLines.push(`<div class="skills-line"><b>Spoken:</b> ${master.skills.spoken_languages.map(s=>
    esc(s.name) + (s.level && s.level !== 'fluent' ? ` (${esc(s.level)})` : '')).join(', ')}</div>`);

// ── Contact — identity facts. Missing pending fields are OMITTED, never guessed. ──
const id_ = master.identity;
const contactParts = [id_.phone, id_.email, id_.location, id_.linkedin, id_.github].filter(Boolean);

verifyTrace(); // guardrail: throws before any file is written if a claim is untraceable

// ── Assemble HTML ─────────────────────────────────────────────────────────────
let html = readFileSync(join(ROOT, 'resume', 'template.html'), 'utf8');
html = html
  .replace(/{{NAME}}/g, esc(id_.name))
  .replace('{{CONTACT_LINE}}', contactParts.map(esc).join(' &nbsp;|&nbsp; '))
  .replace('{{SUMMARY}}', esc(summaryEntry.text))
  .replace('{{EXPERIENCE_HTML}}', experienceHTML)
  .replace('{{PROJECTS_SECTION}}', projectsHTML)
  .replace('{{EDUCATION_HTML}}', educationHTML)
  .replace('{{SKILLS_HTML}}', skillLines.join('\n  '));

const outDir = join(ROOT, 'applications', jobId);
mkdirSync(outDir, { recursive: true });
const htmlPath = join(outDir, 'resume.html');
const pdfPath = join(outDir, 'resume.pdf');
writeFileSync(htmlPath, html);

// ── Print to PDF via headless Chrome ─────────────────────────────────────────
// CHROME_PATH overrides; otherwise the first Chrome/Chromium found (macOS, then Linux — CI runners).
const CHROME = process.env.CHROME_PATH ?? [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find(p => existsSync(p));
if (!CHROME) { console.error('No Chrome/Chromium found — set CHROME_PATH.'); process.exit(1); }
// Observed hang: headless Chrome can wedge mid-render and never return, which
// would otherwise leave a STALE PDF on disk (from a prior run) while the build
// silently never completes — worse than an error, since nothing looks wrong
// until someone opens the PDF. A hard timeout turns that into a loud failure.
//
// Root cause found 2026-11-04: a render that hung on Sep 24 was STILL RUNNING 40 days
// later — the timeout's default SIGTERM didn't kill it, and every later render shared
// Chrome's default headless profile with that zombie, so "the second render hangs" kept
// recurring. Fixes: SIGKILL on timeout (can't be ignored), a throwaway --user-data-dir per
// render (no shared profile/lock with any other Chrome), one retry, and the PDF is deleted
// first so a failure can never leave an older PDF looking current.
function renderPdf(srcHtml, outPdf, label) {
  rmSync(outPdf, { force: true });
  let rendered = false, lastErr = null;
  for (let attempt = 1; attempt <= 2 && !rendered; attempt++) {
    const profile = mkdtempSync(join(tmpdir(), 'jobhunt-chrome-'));
    try {
      execFileSync(CHROME, [
        '--headless', '--disable-gpu', '--no-pdf-header-footer',
        '--print-to-pdf=' + outPdf, '--print-to-pdf-no-header',
        '--no-sandbox', '--virtual-time-budget=5000',
        '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check',
        'file://' + srcHtml,
      ], { stdio: 'pipe', timeout: 30000, killSignal: 'SIGKILL' });
      rendered = existsSync(outPdf) && statSync(outPdf).size > 1000;
      if (!rendered) lastErr = new Error('Chrome exited but wrote no PDF');
    } catch (e) {
      lastErr = e;
      if (attempt === 1) console.error(`  ⚠ ${label} render attempt 1 failed (${e.signal || e.code || e.message}) — retrying once`);
    } finally {
      rmSync(profile, { recursive: true, force: true });
    }
  }
  if (!rendered) {
    throw new Error(`headless Chrome ${label} render failed twice (${lastErr?.signal || lastErr?.code || lastErr?.message}): ${jobId}. ` +
      `No ${label} was written for this job — do not use any older copy.`);
  }
}
renderPdf(htmlPath, pdfPath, 'resume.pdf');

// ── Provenance file ────────────────────────────────────────────────────────────
writeFileSync(join(outDir, 'trace.json'), JSON.stringify({
  job_id: jobId, job_title: job.title, company: job.company,
  generated_at: new Date().toISOString(), lines: TRACE,
  selection_method: SELECTION ? 'jd_matched' : 'category_fallback',
  // Why these bullets, and what the JD asked for that the candidate's record doesn't support — kept
  // with the package so the reasoning is auditable later, not lost in a chat transcript.
  ...(SELECTION ? {
    jd_matched_tags: SELECTION.jd_matched_tags ?? [],
    rationale: SELECTION.rationale ?? null,
    gaps: SELECTION.gaps ?? [],
  } : {}),
}, null, 2));

// ── Cover letter — never invents a company-specific detail it doesn't have ────
const hasRealJD = job.description && job.description.length > 40;
// M10: when the JD-matched selection carries a real, specific detail from the posting (written
// by the tailor pass after actually reading it), it replaces the TODO. Without one, the honest
// placeholder below stays exactly as before — auto-upload removed the wait, not the honesty.
const coverDetail = typeof SELECTION?.cover_detail === 'string' && SELECTION.cover_detail.trim()
  ? SELECTION.cover_detail.trim() : null;
const coverBody = coverDetail
  ? `I'm applying for the ${job.title} role at ${job.company}. ${coverDetail}`
  : hasRealJD
  ? `I'm applying for the ${job.title} role at ${job.company}. [TODO: reference one specific ` +
    `line from the actual job description here — it was not auto-extracted, read the posting ` +
    `at ${job.url} and add one real detail before sending.]`
  : `I'm applying for the ${job.title} role at ${job.company}. [TODO: this source gave no job ` +
    `description — read the actual posting at ${job.url} and add one specific, real reason you ` +
    `want this role before sending. Do not send this letter with the placeholder still in it.]`;
// A résumé bullet ("Engineered a … service …") is shorthand, not prose. In the letter it becomes a
// first-person sentence with the same claim: "In a personal project, I engineered a … service …."
// Which bullet, and its framing, come from master.yaml `cover_letter` — the framing must be true of
// that bullet (e.g. "In a personal project," only for a project the candidate built themselves).
const COVER = master.cover_letter ?? {};
function asSentence(bullet) {
  const t = String(bullet).trim().replace(/\s+/g, ' ');
  const lead = (COVER.framing ?? 'I').trim();
  return `${lead} ${t.charAt(0).toLowerCase()}${t.slice(1)}${/[.!?]$/.test(t) ? '' : '.'}`;
}
const highlight = COVER.highlight_bullet ? findById(COVER.highlight_bullet) : null;
if (COVER.highlight_bullet && !highlight) throw new Error(`cover_letter.highlight_bullet "${COVER.highlight_bullet}" not found in master.yaml`);
const cover = `Dear ${job.company} Hiring Team,

${coverBody}

${highlight ? asSentence(claimCover(highlight)) + ` That's the kind of work I'd bring to ${job.company}.\n` : ''}
Thank you for your consideration.

${master.identity.name}
${master.identity.email}
`;
writeFileSync(join(outDir, 'cover.md'), cover);

// ── Cover letter as a PDF (M14 application kit) ───────────────────────────────
// Only when the letter is complete. While it still carries a [TODO] placeholder, NO cover.pdf
// exists — a file the candidate might upload without re-reading must never contain a placeholder.
const coverPdfPath = join(outDir, 'cover.pdf');
const coverComplete = !/\[TODO/.test(cover);
if (coverComplete) {
  const paras = cover.trim().split(/\n\s*\n/).map(p => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('\n');
  const coverHtml = `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: letter; margin: 0.9in 1in; }
    body { font-family: Arial, Helvetica, "Liberation Sans", sans-serif; font-size: 11pt; line-height: 1.45; color: #111; }
    .hdr { margin-bottom: 22pt; } .hdr b { font-size: 15pt; } .hdr div { font-size: 9.5pt; color: #333; margin-top: 2pt; }
    p { margin: 0 0 11pt; }
  </style></head><body>
    <div class="hdr"><b>${esc(id_.name)}</b><div>${contactParts.map(c => `<span style="white-space:nowrap">${esc(c)}</span>`).join(' &nbsp;|&nbsp; ')}</div></div>
    ${paras}
  </body></html>`;
  writeFileSync(join(outDir, 'cover.html'), coverHtml);
  renderPdf(join(outDir, 'cover.html'), coverPdfPath, 'cover.pdf');
} else {
  rmSync(coverPdfPath, { force: true });
  rmSync(join(outDir, 'cover.html'), { force: true });
}

// ── Screener answers — flags anything resting on a PENDING_DEFAULT ────────────
const profile = loadProfileConfig();
const workAuthPending = profile.candidate.work_authorization === 'PENDING_DEFAULT';
const answers = `# Draft screener answers — ${job.title} @ ${job.company}
# Review every line before pasting into an application. Anything marked
# [CONFIRM] rests on a placeholder value, not a fact the candidate confirmed.

**Why do you want to work here?**
${coverDetail ? `[DRAFT — make it yours before pasting] ${coverDetail}` : "[TODO — needs the real job posting, see cover.md's TODO.]"}

**When do you graduate?**
${edu.expected_grad ? monthYear(edu.expected_grad) : '[MISSING]'}

**Are you authorized to work in the United States?**
${workAuthPending ? '[CONFIRM — profile.yaml has this as a PENDING_DEFAULT guess, not a confirmed fact. Answer this yourself on a real application.]' : profile.candidate.work_authorization}

**What's your availability / hours per week?**
${track === 'parttime' ? `Up to ${profile.logistics.max_hours_week} hrs/week [CONFIRM — placeholder default, not yet confirmed]` : `Full-time for the internship period${profile.candidate.target_term ? ` (${profile.candidate.target_term})` : ''}.`}
`;
writeFileSync(join(outDir, 'answers.md'), answers);

// Structured copy of the same answers for the board's application kit (M14): each answer is
// copied individually there, and anything resting on a placeholder or still a TODO is flagged.
const answerItems = [...answers.matchAll(/\*\*(.+?)\*\*\n([^\n]*)/g)].map(([, q, a]) => ({
  q: q.trim(),
  a: a.replace(/^\[DRAFT — make it yours before pasting\]\s*/, '').trim(),
  draft: /^\[DRAFT/.test(a),
  confirm: /\[CONFIRM/.test(a),
  todo: /\[TODO|\[MISSING/.test(a),
}));
writeFileSync(join(outDir, 'answers.json'), JSON.stringify(answerItems, null, 2));
writeFileSync(join(outDir, 'apply.url'), job.url + '\n');

console.log(`✓ built application package for ${job.title} @ ${job.company}`);
console.log(`  ${outDir}/`);
console.log(`  trace: ${TRACE.length} claim lines, all verified against master.yaml`);
console.log(`  selection: ${SELECTION ? 'JD-matched (selection.json)' : 'category fallback (no real JD text / no override)'}`);
console.log(`  cover.pdf: ${coverComplete ? 'built' : 'NOT built — cover letter still has a [TODO]; finish it first'}`);
