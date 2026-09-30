/**
 * Monochrome audit.
 *
 * Fails if any hex colour in the frontend has meaningful saturation — i.e. if the
 * spread between its highest and lowest RGB channel exceeds a small tolerance.
 *
 * The only permitted exceptions are third-party brand marks (the Google and Slack
 * logos), which must keep their own colours to be recognisable and legally correct.
 *
 *   node scripts/audit-monochrome.mjs
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Channel spread above which a colour counts as "not greyscale". */
const SATURATION_TOLERANCE = 14;

/** Files whose brand marks are allowed to stay in colour. */
const BRAND_MARK_FILES = ['LoginPage.tsx', 'SlackConnectCard.tsx'];

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

const files = walk('apps/web/src').filter((f) => /\.(tsx|ts|css)$/.test(f));

const violations = [];
const allowed = [];

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(/#([0-9a-fA-F]{6})\b/g)) {
    const hex = match[1];
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    const spread = Math.max(r, g, b) - Math.min(r, g, b);
    if (spread <= SATURATION_TOLERANCE) continue;

    const normalised = file.split(/[\\/]/).join('/');
    const entry = { hex: `#${hex}`, spread, file: normalised };
    if (BRAND_MARK_FILES.some((name) => normalised.endsWith(name))) allowed.push(entry);
    else violations.push(entry);
  }
}

if (allowed.length > 0) {
  console.log('allowed third-party brand marks:');
  for (const a of allowed) console.log(`  ${a.hex}  spread ${String(a.spread).padStart(3)}  ${a.file}`);
  console.log('');
}

if (violations.length === 0) {
  console.log('PASS - the interface is monochrome (brand marks excepted)');
  process.exit(0);
}

console.log('FAIL - non-greyscale colours found:');
for (const v of violations) {
  console.log(`  ${v.hex}  spread ${String(v.spread).padStart(3)}  ${v.file}`);
}
process.exit(1);
