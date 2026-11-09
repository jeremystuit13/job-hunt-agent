// Personal config files (profile.yaml, resume/master.yaml) are gitignored. A fresh clone ships
// `*.example.yaml` versions describing a fictional candidate, so every script runs out of the box
// in "demo mode"; copy the examples to the real names to use your own data.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { ROOT } from './db.mjs';

const warned = new Set();

export function configPath(rel) {
  const real = join(ROOT, rel);
  if (existsSync(real)) return real;
  const example = join(ROOT, rel.replace(/\.yaml$/, '.example.yaml'));
  if (existsSync(example)) {
    if (!warned.has(rel)) {
      warned.add(rel);
      console.error(`  ℹ ${rel} not found — using ${rel.replace(/\.yaml$/, '.example.yaml')} (demo candidate). ` +
        `Copy it to ${rel} to use your own data.`);
    }
    return example;
  }
  throw new Error(`missing ${rel} (and no example file to fall back on)`);
}

export const loadYaml = rel => YAML.parse(readFileSync(configPath(rel), 'utf8'));
export const loadMaster = () => loadYaml('resume/master.yaml');
export const loadProfileConfig = () => loadYaml('profile.yaml');
