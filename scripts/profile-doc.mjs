#!/usr/bin/env node
// Builds the board's `meta/profile` doc — the "Your details" block of the application kit (M14) and
// the field source for prefill (M15). Generated from resume/master.yaml + profile.yaml so there is
// one source of truth. Missing facts stay null (never guessed); anything resting on a placeholder or
// an unresolved résumé conflict carries a `note` so the board flags it instead of offering it silently.
//
// Usage: node scripts/profile-doc.mjs   → writes data/meta-profile.json
// (not data/board-writes/ — push.mjs wipes that directory on every run)
// Then (Claude session): Artifact write_db set, collection "meta", doc_id "profile", file_path above.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './lib/db.mjs';
import { loadMaster, loadProfileConfig } from './lib/config.mjs';

const master = loadMaster();
const profile = loadProfileConfig();
const id = master.identity ?? {};
const edu = (master.education ?? []).find(e => e.primary) ?? master.education?.[0] ?? {};
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const monthYear = v => { const m = String(v ?? '').match(/^(\d{4})-(\d{2})/); return m ? `${MONTHS[+m[2] - 1]} ${m[1]}` : null; };
const conflict = key => (master.factual_conflicts_found ?? []).find(c => c.id === key);

const workAuth = profile.candidate?.work_authorization;
const fields = [
  { key: 'name',      label: 'Full name',     value: id.name ?? null, note: null },
  { key: 'email',     label: 'Email',         value: id.email ?? null,
    note: conflict('conflict-application-email') ? `Unresolved: ${conflict('conflict-application-email').ask}` : null },
  { key: 'phone',     label: 'Phone',         value: id.phone ?? null, note: null },
  { key: 'location',  label: 'Location',      value: id.location ?? null, note: null },
  { key: 'linkedin',  label: 'LinkedIn',      value: id.linkedin ? `https://${String(id.linkedin).replace(/^https?:\/\//, '')}` : null, note: null },
  { key: 'github',    label: 'GitHub',        value: id.github ?? null, note: id.github ? null : 'Not provided yet.' },
  { key: 'portfolio', label: 'Portfolio',     value: id.portfolio ?? null, note: null },
  { key: 'school',    label: 'School',        value: edu.school ?? null, note: null },
  { key: 'degree',    label: 'Degree',        value: edu.degree ?? null, note: null },
  { key: 'grad',      label: 'Graduation',    value: monthYear(edu.expected_grad), note: null },
  { key: 'gpa',       label: 'GPA',           value: edu.gpa ?? null, note: edu.gpa ? null : 'Not provided yet.' },
  { key: 'work_auth', label: 'Work authorization', value: workAuth && workAuth !== 'PENDING_DEFAULT' ? workAuth : null,
    note: workAuth === 'PENDING_DEFAULT' ? 'Not confirmed — answer this yourself on every application until it is set in profile.yaml.' : null },
].filter(f => f.value !== null || f.note);   // drop empty fields that carry nothing to say

const doc = { generated_at: new Date().toISOString(), fields };
const dir = join(ROOT, 'data');
mkdirSync(dir, { recursive: true });
const out = join(dir, 'meta-profile.json');
writeFileSync(out, JSON.stringify(doc, null, 2));
console.log(`wrote ${out}`);
for (const f of fields) console.log(`  ${f.label.padEnd(20)} ${f.value ?? '—'}${f.note ? `   ⚠ ${f.note}` : ''}`);
