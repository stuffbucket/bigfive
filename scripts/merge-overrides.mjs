#!/usr/bin/env node
/**
 * Merge new language overrides into result-overrides.json.
 * Usage: node scripts/merge-overrides.mjs < new-langs.json
 * Input: JSON object keyed by language code, e.g. { "pl": {...}, "cs": {...} }
 */
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const filePath = resolve(__dirname, '../src/data/result-overrides.json');

const existing = JSON.parse(readFileSync(filePath, 'utf8'));
const newLangs = JSON.parse(readFileSync('/dev/stdin', 'utf8'));

for (const [code, data] of Object.entries(newLangs)) {
  existing[code] = data;
}

writeFileSync(filePath, JSON.stringify(existing, null, 2) + '\n');
const added = Object.keys(newLangs).join(', ');
console.log(`Added: ${added} (${Object.keys(existing).length - 1} total languages)`);
