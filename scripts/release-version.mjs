#!/usr/bin/env node
/**
 * App version sync — LevelUp (Human OS) app version.
 *
 * Release flow ka last step: ek version dekar saari jagah sync kar deta hai
 * jahan app version dikhta hai. Source of truth = package.json "version".
 *
 * Usage:
 *   node scripts/release-version.mjs --set 2026.09.7002
 *   node scripts/release-version.mjs --set v2026.09.7002     (v prefix ignore)
 *   node scripts/release-version.mjs --set "v2026 09 7002"   (spaces → dots)
 *   node scripts/release-version.mjs --set 2026.09.7002 --dry-run  (sirf report)
 *
 * Kya update hota hai:
 *   - package.json version (hamesha, agar alag hai)
 *   - README.md / README.EN.md / index.html / public/manifest.json /
 *     public/sw.js / capacitor.config.ts / capacitor.config.json — inme
 *     exact OLD version string mile toh replace (kabhi force-add nahi karta)
 *   - package-lock.json root version — SIRF tab jab wo pehle se package.json
 *     ke barabar ho (repo me wo "0.0.0" pe intentionally stuck hai; usse
 *     zyada kuch nahi todte)
 *
 * src/ kabhi scan NAHI hota: vendored/bundled files me "7000" jaisi numbers
 * timeout/fonts ke hote hain — version mat samjho.
 *
 * Safe/Idempotent: agar version already set hai toh bas baaki files me stale
 * occurrence check karta hai aur "nothing to update" bolta hai. Invalid
 * version → exit 1 (release abort).
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = path.join(root, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

/** App version scheme: YYYY.MM.BUILD (e.g. 2026.09.7002). */
const VERSION_RE = /^\d{4}\.\d{2}\.\d+$/;

/** Safe list — jahan exact OLD version string replace ho sakta hai. */
const SYNC_FILES = [
  'package-lock.json',
  'README.md',
  'README.EN.md',
  'index.html',
  'public/manifest.json',
  'public/sw.js',
  'capacitor.config.ts',
  'capacitor.config.json',
];

function fail(msg) {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

// ---- parse args ----
const args = process.argv.slice(2);
const setIdx = args.indexOf('--set');
const raw = setIdx >= 0 ? args[setIdx + 1] : undefined;
if (!raw) fail('--set <version> required (e.g. --set 2026.09.7002)');
const dryRun = args.includes('--dry-run');

// Normalise: leading "v" hatao, spaces ko dots me badlo ("v2026 09 7002" → "2026.09.7002").
const next = raw.trim().replace(/^v/i, '').replace(/\s+/g, '.');
if (!VERSION_RE.test(next)) {
  fail(`Invalid app version "${next}" — expected YYYY.MM.BUILD (e.g. 2026.09.7002)`);
}

const current = pkg.version;
const changed = [];

// ---- sync stale occurrences (exact OLD string replace only) ----
for (const rel of SYNC_FILES) {
  const abs = path.join(root, rel);
  if (!existsSync(abs)) continue;
  let text;
  try {
    text = readFileSync(abs, 'utf8');
  } catch {
    continue; // unreadable file → skip, koi dir nahi todi
  }
  if (!text.includes(current)) continue;
  const updated = text.split(current).join(next);
  if (!dryRun) writeFileSync(abs, updated, 'utf8');
  changed.push(rel);
}

// ---- package.json source of truth (JSON-level write, formatting preserve) ----
if (current !== next) {
  if (!dryRun) {
    pkg.version = next;
    const raw = readFileSync(pkgPath, 'utf8');
    const trailing = raw.endsWith('\n') ? '\n' : '';
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}${trailing}`, 'utf8');
  }
  changed.push('package.json');
}

// ---- report ----
if (dryRun) console.log('⏳ DRY RUN — kuch nahi likha, sirf report:');
if (changed.length === 0) {
  console.log(`ℹ️  Version already at ${next} — koi stale occurrence nahi mila.`);
  process.exit(0);
}
console.log(`✅ App version${dryRun ? ' (would be)' : ''} synced: ${current} → ${next}`);
console.log(`   Updated: ${changed.join(', ')}`);

if (current !== next) {
  console.log(`\n🔎 Commit suggestion: git add ${changed.join(' ')} && git commit -m "chore(release): bump version to ${next}"`);
}