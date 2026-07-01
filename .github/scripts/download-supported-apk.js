#!/usr/bin/env node
'use strict';

/**
 * download-supported-apk.js
 *
 * For a single matrix entry, ensure the target-version APK is present
 * in $APKS_DIR (downloading, picking from cache, or merging a split
 * package as needed), validate its version with aapt, and emit the
 * chosen APK path + version as workflow outputs.
 *
 * Extracted from the ~480-line inline bash block in morphe-build.yml's
 * "Download supported APK for ${{ matrix.appId }}" step. Behavior
 * intentionally identical to that bash — the same fallback chain:
 *
 *   1. Cached APK already in $APKS_DIR matching the target version.
 *   2. Pre-downloaded APK in $TOOLS_DIR (from check-versions).
 *   3. unified-downloader.js (URL cache → parallel resolve → sequential).
 *   4. Manual APKMirror URL from config.json download_urls[pkg].latest_supported.
 *   5. If pinned and everything above failed: emergency fallback to
 *      morphe-cli list-versions, retry with the head of that list.
 *
 * Then: aapt-validate, score-rank candidate, merge split packages
 * (APKEditor first, manual extract as fallback), and require classes.dex.
 *
 * Inputs (env vars):
 *   APP_ID         required  package id
 *   TARGET_VERSION required  selected version from resolve-supported-version step
 *   TARGET_VERSIONS optional comma-separated list of all compatible versions
 *                            (used only for the "All compatible versions" log line)
 *   APKS_DIR       required  destination directory for the chosen APK
 *   TOOLS_DIR      required  where pre-downloaded APKs / .mpp / .jar live
 *   APKEDITOR_JAR  optional  APKEditor.jar path (needed for split-package merge)
 *   PINNED_CHECK   optional  same as config.json patch_repos[pkg].pin_version
 *   PATCH_REPO     optional  patch repo (for emergency fallback)
 *   MORPHE_CLI_JAR optional  morphe-cli jar (for emergency fallback)
 *   MANUAL_URL     optional  config.json download_urls[pkg].latest_supported
 *   RUNNER_TEMP    optional  temp dir (default /tmp)
 *   GITHUB_OUTPUT  required  workflow output file
 *
 * Outputs ($GITHUB_OUTPUT):
 *   apk     absolute path of the chosen APK
 *   version APK's version (from filename, falling back to TARGET_VERSION)
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const {
  extractVersionFromString,
  findCachedApk,
  findPackageCandidate,
  bestRankedApkInDir,
  apkHasDex,
} = require('./apk-selection');

const APP_ID = process.env.APP_ID;
const TARGET_VERSION = process.env.TARGET_VERSION || '';
const TARGET_VERSIONS = process.env.TARGET_VERSIONS || '';
const APKS_DIR = process.env.APKS_DIR;
const TOOLS_DIR = process.env.TOOLS_DIR;
const APKEDITOR_JAR = process.env.APKEDITOR_JAR || '';
const PINNED_CHECK = process.env.PINNED_CHECK || '';
const PATCH_REPO = process.env.PATCH_REPO || '';
const MORPHE_CLI_JAR = process.env.MORPHE_CLI_JAR || '';
const MANUAL_URL = process.env.MANUAL_URL || '';
const RUNNER_TEMP = process.env.RUNNER_TEMP || '/tmp';
const GITHUB_OUTPUT = process.env.GITHUB_OUTPUT;

if (!APP_ID || !APKS_DIR || !TOOLS_DIR) {
  console.error('::error::APP_ID, APKS_DIR, and TOOLS_DIR are required.');
  process.exit(1);
}
if (!GITHUB_OUTPUT) {
  console.error('::error::GITHUB_OUTPUT not set; this script must run inside a workflow step.');
  process.exit(1);
}

function setOutput(key, value) {
  if (value === undefined || value === null) value = '';
  const line = `${key}=${value}`;
  console.log(line);
  fs.appendFileSync(GITHUB_OUTPUT, line + '\n');
}

function ensureDir(d) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

/**
 * Wrap the unified-downloader.js invocation in a child node process so
 * its JSON output can be parsed without an in-process import (avoids
 * polluting the test environment).
 */
function runUnifiedDownloader(appId, version, apksDir) {
  const script = path.join(__dirname, 'unified-downloader.js');
  const r = spawnSync(process.execPath, [script, appId, version, apksDir], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    timeout: 600000,
  });
  if (r.error) return { ok: false, error: r.error.message };
  const stdout = (r.stdout || '').trim();
  if (!stdout) return { ok: false, error: 'unified-downloader produced no output' };
  try {
    const parsed = JSON.parse(stdout);
    return parsed.success
      ? { ok: true, result: parsed }
      : { ok: false, error: parsed.error || 'unknown' };
  } catch (e) {
    return { ok: false, error: `could not parse unified-downloader output: ${e.message}` };
  }
}

/**
 * Curl-with-retries fallback. Mirrors the bash `download_with_curl`:
 * 4 attempts, exponential-ish sleep, size sanity check.
 */
function downloadWithCurl(url, apksDir, appId) {
  if (!url) {
    console.error('::error::Manual APKMirror URL is empty.');
    return null;
  }
  console.error(`Using APK source URL for ${appId}: ${url}`);

  let apkName = url.split('/').pop().replace(/\/$/, '');
  if (!apkName) apkName = `${appId}.apk`;
  if (!/\.(apk|xapk|apkm|apks)$/i.test(apkName)) apkName += '.apk';
  const outputFile = path.join(apksDir, apkName);

  const MAX = 4;
  for (let attempt = 1; attempt <= MAX; attempt++) {
    console.log(`Download attempt ${attempt}/${MAX}...`);
    let r;
    try {
      r = spawnSync('curl', [
        '-fL', '--retry', '4', '--retry-delay', '5', '--connect-timeout', '30',
        '-A', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        '-H', 'Accept: */*',
        '-H', 'Accept-Language: en-US,en;q=0.9',
        '-H', 'Referer: https://www.apkmirror.com/',
        '-o', outputFile,
        url,
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      r = { error: e };
    }
    if (r.status === 0 && fs.existsSync(outputFile)) {
      const size = fs.statSync(outputFile).size;
      if (size > 1000) {
        console.log(`Download saved: ${outputFile}`);
        return outputFile;
      }
    }
    if (attempt >= MAX) {
      console.error(`Download failed after ${MAX} attempts.`);
      try { fs.unlinkSync(outputFile); } catch { /* ignore */ }
      return null;
    }
    console.log(`Download attempt ${attempt} failed, retrying...`);
    spawnSync('sleep', [String(attempt * 10)]);
    try { fs.unlinkSync(outputFile); } catch { /* ignore */ }
  }
  return null;
}

/**
 * Try aapt dump badging and return the versionName, or '' if not available.
 */
function readApkVersion(apkPath) {
  let info;
  try {
    info = execFileSync('aapt', ['dump', 'badging', apkPath], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    try {
      info = execFileSync('aapt2', ['dump', 'badging', apkPath], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      return '';
    }
  }
  const m = info.match(/versionName='([^']+)'/);
  return m ? m[1] : '';
}

/**
 * Merge a split package with APKEditor. Returns true on success (writes
 * `outApk`), false otherwise. Mirrors merge_split_package_with_apkeditor.
 */
function mergeSplitPackageWithApkeditor(splitPkg, outApk) {
  if (!APKEDITOR_JAR || !fs.existsSync(APKEDITOR_JAR)) {
    console.error('APKEditor jar not available; cannot merge split package.');
    return false;
  }
  try { fs.unlinkSync(outApk); } catch { /* ignore */ }
  const mergeLog = path.join(RUNNER_TEMP, `apkeditor_merge_${APP_ID}.log`);
  console.error(`Merging split package with APKEditor: ${splitPkg}`);
  let r;
  try {
    r = spawnSync('java', ['-jar', APKEDITOR_JAR, 'm', '-i', splitPkg, '-o', outApk], {
      encoding: 'utf8', stdio: ['ignore', fs.openSync(mergeLog, 'w'), fs.openSync(mergeLog, 'a')],
    });
  } catch (e) {
    r = { error: e, status: null };
  }
  if ((r.status === 0) && !fs.existsSync(outApk)) {
    const defaultMerged = splitPkg.replace(/\.[^.]+$/, '') + '_merged.apk';
    const fallbackMerged = findFirstFile(path.dirname(splitPkg), '_merged.apk');
    if (fs.existsSync(defaultMerged)) {
      fs.renameSync(defaultMerged, outApk);
    } else if (fallbackMerged && fs.existsSync(fallbackMerged)) {
      fs.renameSync(fallbackMerged, outApk);
    }
  }
  if (r.status !== 0 || !fs.existsSync(outApk)) {
    console.error(`APKEditor merge failed for ${splitPkg}`);
    try { console.error(fs.readFileSync(mergeLog, 'utf8')); } catch { /* ignore */ }
    return false;
  }
  if (!apkHasDex(outApk)) {
    console.error(`APKEditor output has no classes.dex: ${outApk}`);
    return false;
  }
  return true;
}

function findFirstFile(dir, suffix) {
  let list;
  try { list = fs.readdirSync(dir); } catch { return null; }
  for (const f of list) {
    if (f.endsWith(suffix)) return path.join(dir, f);
  }
  return null;
}

// === Main ===
console.log(`Downloading APK for ${APP_ID}...`);
ensureDir(APKS_DIR);

let downloadSuccess = false;

// 1. Check for cached APK matching target version
const cached = findCachedApk(APKS_DIR, TARGET_VERSION);
if (cached) {
  console.log(`Using cached APK: ${cached} (v${TARGET_VERSION})`);
  downloadSuccess = true;
} else {
  // Clear stale files in APKS_DIR (preserves nothing for this run).
  try {
    for (const f of fs.readdirSync(APKS_DIR)) {
      try { fs.unlinkSync(path.join(APKS_DIR, f)); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

// 2. Pre-downloaded APK from TOOLS_DIR?
if (!downloadSuccess) {
  if (!TARGET_VERSION) {
    console.error(`::error::No latest Morphe-supported version was resolved for ${APP_ID}.`);
    process.exit(1);
  }

  const preloaded = findCachedApk(TOOLS_DIR, TARGET_VERSION);
  if (preloaded) {
    console.log(`Using pre-downloaded APK from check-versions: ${preloaded} (matches v${TARGET_VERSION})`);
    fs.copyFileSync(preloaded, path.join(APKS_DIR, path.basename(preloaded)));
    downloadSuccess = true;
  } else {
    console.log(`No matching APK found for v${TARGET_VERSION}, using unified-downloader...`);
    const dl = runUnifiedDownloader(APP_ID, TARGET_VERSION, APKS_DIR);
    if (dl.ok) {
      console.log(`unified-downloader succeeded: ${JSON.stringify(dl.result)}`);
      downloadSuccess = true;
    } else {
      console.log(`unified-downloader failed: ${dl.error}`);
      if (MANUAL_URL) {
        console.log('Trying manual URL fallback...');
        if (downloadWithCurl(MANUAL_URL, APKS_DIR, APP_ID)) {
          downloadSuccess = true;
        }
      }
    }
  }
}

// 3. Pinned-version emergency fallback
if (!downloadSuccess) {
  if (PINNED_CHECK && PINNED_CHECK !== 'null' && PINNED_CHECK === TARGET_VERSION) {
    console.error(`::warning::Pinned version ${PINNED_CHECK} download failed; attempting emergency fallback to list-versions...`);
    const slug = PATCH_REPO.replace(/\//g, '-');
    const mppFile = path.join(TOOLS_DIR, `${slug}.mpp`);
    if (fs.existsSync(mppFile) && MORPHE_CLI_JAR && fs.existsSync(MORPHE_CLI_JAR)) {
      let out;
      try {
        out = execFileSync(
          'java',
          ['-jar', MORPHE_CLI_JAR, 'list-versions', '-f', APP_ID, '--patches=' + mppFile],
          { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] },
        );
      } catch (e) {
        out = '';
      }
      const versions = out.match(/\d+\.\d+\.\d+/g) || [];
      if (versions.length > 0) {
        const fallbackVersion = versions[0];
        console.log(`Emergency fallback: retrying with version ${fallbackVersion}`);
        const dl = runUnifiedDownloader(APP_ID, fallbackVersion, APKS_DIR);
        if (dl.ok) {
          console.log(`Emergency fallback succeeded: ${JSON.stringify(dl.result)}`);
          // Update TARGET_VERSION so downstream validation picks it up.
          process.env.TARGET_VERSION = fallbackVersion;
          downloadSuccess = true;
        } else {
          console.log(`Emergency fallback also failed: ${dl.error}`);
        }
      }
    }
  }
  if (!downloadSuccess) {
    console.error(`::error::No APK could be downloaded for ${APP_ID} version ${TARGET_VERSION}.`);
    process.exit(1);
  }
}

// 4. aapt validation pass — drop any APKs with the wrong versionName.
const effectiveTargetVersion = process.env.TARGET_VERSION || TARGET_VERSION;
console.log(`Validating APK version matches target v${effectiveTargetVersion} using aapt...`);

let apkValid = false;
const apkFiles = fs.readdirSync(APKS_DIR).filter(f => f.endsWith('.apk'));
for (const f of apkFiles) {
  const full = path.join(APKS_DIR, f);
  const versionName = readApkVersion(full);
  console.log(`::debug::APK: ${f} -> versionName=${versionName}`);
  if (versionName === effectiveTargetVersion) {
    console.log(`APK version validated: ${f} is v${versionName} (matches target)`);
    apkValid = true;
    break;
  } else if (!versionName) {
    // aapt couldn't read the version (not installed or unsupported format);
    // unified-downloader already validated, so accept the APK.
    console.log('Could not read APK version via aapt (aapt unavailable); trusting unified-downloader validation');
    apkValid = true;
    break;
  } else {
    console.log(`APK has wrong version: ${f} is v${versionName} but wanted v${effectiveTargetVersion} - removing`);
    try { fs.unlinkSync(full); } catch { /* ignore */ }
  }
}

// 5. Also check split packages
if (!apkValid) {
  for (const ext of ['xapk', 'apkm', 'apks']) {
    const splitFiles = fs.readdirSync(APKS_DIR).filter(f => f.endsWith('.' + ext));
    for (const f of splitFiles) {
      const full = path.join(APKS_DIR, f);
      console.log(`Checking split package: ${f}`);
      const tmpDir = fs.mkdtempSync(path.join(RUNNER_TEMP, 'split_validate_'));
      try {
        const r = spawnSync('unzip', ['-q', full, 'base.apk', '-d', tmpDir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        if (r.status === 0) {
          const baseApk = path.join(tmpDir, 'base.apk');
          if (fs.existsSync(baseApk)) {
            const splitVersion = readApkVersion(baseApk);
            console.log(`::debug::Split package base APK version: ${splitVersion} (expected: ${effectiveTargetVersion})`);
            if (splitVersion && splitVersion !== effectiveTargetVersion) {
              console.log(`Split package has wrong version: ${splitVersion} (expected ${effectiveTargetVersion}) - removing`);
              try { fs.unlinkSync(full); } catch { /* ignore */ }
              continue;
            }
            console.log(`Split package version validated: ${splitVersion}`);
          }
        }
      } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
      // We'll re-validate after merge.
      apkValid = true;
      break;
    }
    if (apkValid) break;
  }
}

if (!apkValid) {
  console.error(`::error::No APK found with correct version v${effectiveTargetVersion}`);
  console.error(`Files in ${APKS_DIR}:`);
  try { console.error(fs.readdirSync(APKS_DIR).join('\n')); } catch { /* ignore */ }
  process.exit(1);
}

// 6. Pick best APK candidate.
let apkCandidate = findPackageCandidate(APKS_DIR);
if (!apkCandidate) {
  console.error(`::error::No package downloaded for latest Morphe-supported version ${effectiveTargetVersion} for ${APP_ID}.`);
  console.error(`All compatible versions (for reference): ${TARGET_VERSIONS}`);
  process.exit(1);
}
if (!fs.existsSync(apkCandidate)) {
  console.error(`::error::Resolved package path is missing: ${apkCandidate}`);
  console.error(`Files in ${APKS_DIR}:`);
  try { console.error(fs.readdirSync(APKS_DIR).join('\n')); } catch { /* ignore */ }
  process.exit(1);
}
console.log(`Found package in ${APKS_DIR}: ${apkCandidate}`);

// 7. If the candidate is an APK without classes.dex, try to swap to a
//    dex-bearing APK from the same directory; failing that, fall back
//    to the first split package (which will be merged next).
if (apkCandidate.endsWith('.apk') && !apkHasDex(apkCandidate)) {
  console.log('Selected APK does not contain classes.dex; trying another APK candidate.');
  const ranked = bestRankedApkInDir(APKS_DIR);
  for (const c of ranked) {
    if (apkHasDex(c)) {
      apkCandidate = c;
      console.log(`Using APK with dex content: ${apkCandidate}`);
      break;
    }
  }
}
if (apkCandidate.endsWith('.apk') && !apkHasDex(apkCandidate)) {
  const splitFound = fs.readdirSync(APKS_DIR).find(f => /\.(xapk|apkm|apks)$/.test(f));
  if (splitFound) {
    console.log(`Switching to split package for merge: ${splitFound}`);
    apkCandidate = path.join(APKS_DIR, splitFound);
  }
}

// 8. Merge split packages into a standalone APK if necessary.
let finalApk = apkCandidate;
if (/\.(xapk|apkm|apks)$/.test(apkCandidate)) {
  console.log(`Split package detected (${apkCandidate}); attempting APKEditor merge...`);
  const outApk = path.join(APKS_DIR, `${APP_ID}.apk`);
  if (mergeSplitPackageWithApkeditor(apkCandidate, outApk)) {
    console.log(`Merged APK created: ${outApk}`);
    console.log('Validating merged APK version...');
    const mergedVersion = readApkVersion(outApk);
    console.log(`::debug::Merged APK version: ${mergedVersion} (expected: ${effectiveTargetVersion})`);
    if (mergedVersion && mergedVersion !== effectiveTargetVersion) {
      console.error(`::error::Merged APK has wrong version: ${mergedVersion} (expected ${effectiveTargetVersion})`);
      process.exit(1);
    }
    finalApk = outApk;
  } else {
    console.log('APKEditor merge failed; falling back to direct APK extraction.');
    const xapkTmp = fs.mkdtempSync(path.join(RUNNER_TEMP, `xapk_${APP_ID}_`));
    try {
      const r = spawnSync('unzip', ['-o', '-q', apkCandidate, '*.apk', '-d', xapkTmp], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      if (r.status !== 0) console.error('unzip on split package failed (continuing)');

      let extracted = null;
      const ranked = bestRankedApkInDir(xapkTmp);
      for (const c of ranked) {
        if (apkHasDex(c)) { extracted = c; break; }
      }
      if (!extracted) {
        // Last fallback: largest dex-bearing APK.
        try {
          const files = fs.readdirSync(xapkTmp).map(f => {
            const full = path.join(xapkTmp, f);
            return { full, size: fs.statSync(full).size };
          }).sort((a, b) => b.size - a.size);
          for (const f of files) {
            if (apkHasDex(f.full)) { extracted = f.full; break; }
          }
        } catch { /* ignore */ }
      }
      if (!extracted || !fs.existsSync(extracted)) {
        console.error(`::error::Could not extract APK from split package: ${apkCandidate}`);
        try {
          const files = fs.readdirSync(xapkTmp).filter(f => f.endsWith('.apk'));
          console.error('Archive APK contents:', files.join(' '));
        } catch { /* ignore */ }
        process.exit(1);
      }
      fs.copyFileSync(extracted, outApk);
      console.log(`Extracted APK: ${outApk} (from ${path.basename(extracted)})`);
      finalApk = outApk;
    } finally {
      try { fs.rmSync(xapkTmp, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
}

if (!fs.existsSync(finalApk)) {
  console.error(`::error::APK path check failed: ${finalApk}`);
  process.exit(1);
}
if (!apkHasDex(finalApk)) {
  console.error(`::error::Chosen APK has no classes.dex and cannot be patched: ${finalApk}`);
  try {
    const files = fs.readdirSync(APKS_DIR).filter(f => /\.(apk|xapk|apkm|apks)$/.test(f));
    console.error(`Files in ${APKS_DIR}:`, files.join(' '));
  } catch { /* ignore */ }
  process.exit(1);
}

console.log(`Downloaded ${APP_ID} → ${finalApk}`);

// 9. Outputs
setOutput('apk', finalApk);
const apkFilename = path.basename(finalApk);
let apkVersion = extractVersionFromString(apkFilename);
if (!apkVersion && effectiveTargetVersion) apkVersion = effectiveTargetVersion;
if (!apkVersion) apkVersion = 'unknown';
setOutput('version', apkVersion);
console.log(`Downloaded ${APP_ID} → ${finalApk} (v${apkVersion})`);
