#!/usr/bin/env node
// Probe every candidate board token and promote only the ones that actually answer.
// A wrong Greenhouse token 404s silently, so untested tokens are worse than none.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { ROOT } from './lib/db.mjs';
import { looksLikeIntern, looksLikeSummer2027 } from './lib/util.mjs';

const P = join(ROOT, 'sources.yaml');
const cfg = YAML.parse(readFileSync(P, 'utf8'));
const cand = cfg.boards.candidates ?? {};
const URLS = {
  greenhouse: t => `https://boards-api.greenhouse.io/v1/boards/${t}/jobs?content=true`,
  ashby:      t => `https://api.ashbyhq.com/posting-api/job-board/${t}`,
  lever:      t => `https://api.lever.co/v0/postings/${t}?mode=json`,
};
const good = { greenhouse: [], ashby: [], lever: [] };
const bad = [];

for (const [kind, tokens] of Object.entries(cand)) {
  for (const tok of tokens) {
    try {
      const r = await fetch(URLS[kind](tok), { headers: { 'User-Agent': 'jobhunt/1.0' } });
      if (!r.ok) { bad.push(`${kind}/${tok} → HTTP ${r.status}`); continue; }
      const d = await r.json();
      const jobs = kind === 'lever' ? (Array.isArray(d) ? d : null) : d.jobs;
      if (!Array.isArray(jobs)) { bad.push(`${kind}/${tok} → no jobs array`); continue; }
      const titles = jobs.map(j => j.title ?? j.text ?? '');
      const interns = titles.filter(looksLikeIntern);
      const s27 = jobs.filter(j => looksLikeSummer2027(
        `${j.title ?? j.text ?? ''} ${j.content ?? j.descriptionPlain ?? ''}`));
      good[kind].push(tok);
      console.log(`  ✓ ${kind}/${tok}`.padEnd(30) +
        `${String(jobs.length).padStart(4)} open · ${String(interns.length).padStart(3)} intern · ${s27.length} s27`);
    } catch (e) { bad.push(`${kind}/${tok} → ${e.message}`); }
  }
}
console.log('\n  failed / not a customer:');
for (const b of bad) console.log(`  ✗ ${b}`);

cfg.boards.greenhouse = good.greenhouse;
cfg.boards.ashby = good.ashby;
cfg.boards.lever = good.lever;
writeFileSync(P, YAML.stringify(cfg, { lineWidth: 100 }));
const n = Object.values(good).flat().length;
console.log(`\n  promoted ${n} verified tokens into sources.yaml (${bad.length} rejected)`);
