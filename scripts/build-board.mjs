#!/usr/bin/env node
// Bakes the current top-of-board slice (data/board-seed.json, written by push.mjs) into the board
// page as its first-paint / offline fallback, producing board/dist/board.html — the file that gets
// published as the Artifact. board/board.html stays a clean source file with an empty seed.
//
// Usage: node scripts/build-board.mjs
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './lib/db.mjs';

const src = readFileSync(join(ROOT, 'board', 'board.html'), 'utf8');
const seedPath = join(ROOT, 'data', 'board-seed.json');
const seed = existsSync(seedPath) ? JSON.parse(readFileSync(seedPath, 'utf8'))
  : { generated_at: null, internships: [], parttime: [] };

const PLACEHOLDER = /  var SEED = \{ generated_at: null, internships: \[\], parttime: \[\] \};[^\n]*\n/;
if (!PLACEHOLDER.test(src)) throw new Error('board/board.html: SEED placeholder not found');
// Escape "</" so job text can never close the <script> element early.
const json = JSON.stringify(seed).replace(/<\//g, '<\\/');
const out = src.replace(PLACEHOLDER, () => `  var SEED = ${json};\n`);

mkdirSync(join(ROOT, 'board', 'dist'), { recursive: true });
writeFileSync(join(ROOT, 'board', 'dist', 'board.html'), out);
console.log(`board/dist/board.html — seeded with ${seed.internships.length} internships, ${seed.parttime.length} part-time`);
