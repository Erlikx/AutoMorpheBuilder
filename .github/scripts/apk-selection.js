#!/usr/bin/env node
'use strict';

/**
 * apk-selection.js — pure scoring/ranking helpers for picking the best
 * APK candidate from a directory containing APKs / split packages.
 *
 * Extracted from the inline awk score() function that previously lived
 * inside the "Download supported APK" workflow step. Kept in a separate
 * file so the logic can be unit-tested (see __tests__/apk-selection.test.js)
 * independently of the workflow step that drives it.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

/**
 * Extract the first X.Y.Z version-like sequence from a string (typically
 * an APK filename). Returns the matched substring, or ''.
 */
function extractVersionFromString(s) {
  const m = String(s).match(/\d+(?:\.\d+){2,}/);
  return m ? m[0] : '';
}

/**
 * Pure scoring function used by findPackageCandidate and bestRankedApkInDir.
 * Higher score = better match for our preferred architecture/format.
 *
 * The bonus/penalty weights are the same numbers the inline awk used;
 * changing them changes APK selection behavior, which the workflow
 * relies on (rejects dex-less split configs, prefers arm64-v8a APKs, etc.).
 *
 * @param {string} apkPath Absolute path to an APK file.
 * @returns {number} Score (higher is better).
 */
function scoreApk(apkPath) {
  const lower = String(apkPath).toLowerCase();
  const ext = lower.replace(/^.*\./, '');

  let s = 0;
  // .apk is the patchable shape we want; .xapk/.apkm/.apks are split packages.
  if (ext === 'apk') s += 2000;
  else if (ext === 'xapk' || ext === 'apkm' || ext === 'apks') s += 500;

  // For dir-listings, prefer arm64-v8a and demote other arches.
  if (/arm64-v8a|arm64_v8a|arm64/.test(lower)) s += 800;
  if (/\/base\.apk$/.test(lower)) s += 500;
  if (/x86_64|x86/.test(lower)) s -= 600;
  if (/armeabi-v7a|arm-v7a|v7a/.test(lower)) s -= 300;
  if (/split_config|(^|\/)config\./.test(lower)) s -= 1400;
  return s;
}

/**
 * Find a cached APK (or split package) in APKS_DIR that matches the
 * target version. Mirrors the for-ext/while-find bash loop.
 *
 * @param {string} apksDir   Directory to scan (one level deep).
 * @param {string} targetVersion X.Y.Z version to match against filename.
 * @returns {string|null} Absolute path, or null if nothing matches.
 */
function findCachedApk(apksDir, targetVersion) {
  if (!fs.existsSync(apksDir)) return null;
  const exts = ['apk', 'xapk', 'apkm', 'apks'];
  for (const ext of exts) {
    let entries;
    try {
      entries = fs.readdirSync(apksDir).filter(f => f.endsWith('.' + ext));
    } catch {
      continue;
    }
    for (const entry of entries) {
      const ver = extractVersionFromString(entry);
      if (ver === targetVersion) return path.join(apksDir, entry);
    }
  }
  return null;
}

/**
 * Scan APKS_DIR for all .apk/.xapk/.apkm/.apks files and return the
 * highest-scored one. Mirrors the find_package_candidate awk pipeline.
 *
 * @param {string} apksDir Directory to scan (recursive).
 * @returns {string|null} Absolute path of best candidate, or null.
 */
function findPackageCandidate(apksDir) {
  if (!fs.existsSync(apksDir)) return null;
  const entries = [];
  const walk = (dir) => {
    let list;
    try { list = fs.readdirSync(dir); } catch { return; }
    for (const f of list) {
      const full = path.join(dir, f);
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      if (stat.isDirectory()) walk(full);
      else if (/\.(apk|xapk|apkm|apks)$/i.test(full)) entries.push(full);
    }
  };
  walk(apksDir);
  if (entries.length === 0) return null;
  let best = null;
  let bestScore = -Infinity;
  for (const e of entries) {
    const s = scoreApk(e);
    if (s > bestScore) { best = e; bestScore = s; }
  }
  return best;
}

/**
 * Variant of findPackageCandidate used after a split-package fallback:
 * returns every .apk under `dir`, sorted best-first. The caller then
 * picks the first one whose contents include classes*.dex.
 *
 * @param {string} dir Directory to scan.
 * @returns {string[]} Absolute paths sorted by score, descending.
 */
function bestRankedApkInDir(dir) {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir)
    .filter(f => f.endsWith('.apk'))
    .map(f => path.join(dir, f));
  return entries
    .map(p => ({ path: p, score: scoreApk(p) }))
    .sort((a, b) => b.score - a.score)
    .map(o => o.path);
}

/**
 * Returns true if `apk` is a (likely) patchable APK — i.e. its zip
 * contents include classes.dex / classes2.dex / etc.
 */
function apkHasDex(apk) {
  try {
    const out = execFileSync('unzip', ['-Z1', apk], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return /^classes(?:\d+)?\.dex$/m.test(out);
  } catch {
    return false;
  }
}

module.exports = {
  extractVersionFromString,
  scoreApk,
  findCachedApk,
  findPackageCandidate,
  bestRankedApkInDir,
  apkHasDex,
};