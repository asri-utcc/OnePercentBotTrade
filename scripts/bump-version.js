#!/usr/bin/env node
'use strict';

/**
 * FIX-2026-08-26: Auto-suggest next version from commit history
 *
 * Reads commit log since last git tag, counts prefixes:
 *   - BREAKING CHANGE / BREAKING: → MAJOR bump
 *   - feat: → MINOR bump
 *   - fix / FIX: → PATCH bump
 *
 * Usage:
 *   node scripts/bump-version.js            # print suggested next version
 *   node scripts/bump-version.js --apply    # update package.json + tag current HEAD
 *   node scripts/bump-version.js --help
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PKG_PATH = path.join(__dirname, '..', 'package.json');

function _sh(cmd) {
  return execSync(cmd, { cwd: path.join(__dirname, '..'), encoding: 'utf8' }).trim();
}

function getCurrentVersion() {
  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
  return pkg.version;
}

function getLatestTag() {
  try {
    return _sh('git describe --tags --abbrev=0');
  } catch (e) {
    return null;
  }
}

function getCommitsSinceTag(tag) {
  const range = tag ? `${tag}..HEAD` : 'HEAD';
  try {
    return _sh(`git log ${range} --pretty=format:"%s"`).split('\n').filter(Boolean);
  } catch (e) {
    return [];
  }
}

function classifyCommit(msg) {
  const lower = msg.toLowerCase();
  if (/breaking\s*change|breaking:|\!:/i.test(msg)) return 'major';
  if (/^feat[:(]/i.test(msg)) return 'minor';
  if (/^fix[:(]/i.test(msg)) return 'patch';
  return null; // chore/docs/test/refactor — no bump
}

function bumpVersion(v, type) {
  const [maj, min, pat] = v.split('.').map(Number);
  if (type === 'major') return `${maj + 1}.0.0`;
  if (type === 'minor') return `${maj}.${min + 1}.0`;
  if (type === 'patch') return `${maj}.${min}.${pat + 1}`;
  return v;
}

function summarize(commits) {
  const counts = { major: 0, minor: 0, patch: 0, other: 0 };
  const samples = { major: [], minor: [], patch: [] };
  for (const c of commits) {
    const cls = classifyCommit(c);
    if (cls) {
      counts[cls]++;
      if (samples[cls].length < 5) samples[cls].push(c);
    } else {
      counts.other++;
    }
  }
  return { counts, samples };
}

function pickBumpType(counts) {
  if (counts.major > 0) return 'major';
  if (counts.minor > 0) return 'minor';
  if (counts.patch > 0) return 'patch';
  return null;
}

function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');

  if (args.includes('--help')) {
    console.log('Usage:');
    console.log('  node scripts/bump-version.js          # show suggested next version');
    console.log('  node scripts/bump-version.js --apply  # update package.json + git tag');
    console.log('');
    console.log('Reads last git tag, scans commits since then, suggests:');
    console.log('  MAJOR  if any "BREAKING CHANGE" / "BREAKING:" commits');
    console.log('  MINOR  if any "feat:" commits');
    console.log('  PATCH  if any "fix:" commits');
    process.exit(0);
  }

  const current = getCurrentVersion();
  const tag = getLatestTag();
  const commits = getCommitsSinceTag(tag);
  const { counts, samples } = summarize(commits);
  const bumpType = pickBumpType(counts);
  const next = bumpType ? bumpVersion(current, bumpType) : current;

  console.log('Current version:', current);
  console.log('Latest git tag: ', tag || '(none)');
  console.log('Commits since tag:', commits.length);
  console.log('---');
  console.log('Commit classification:');
  console.log('  MAJOR (BREAKING):', counts.major);
  if (samples.major.length) console.log('    ' + samples.major.join('\n    '));
  console.log('  MINOR (feat):    ', counts.minor);
  if (samples.minor.length) console.log('    ' + samples.minor.join('\n    '));
  console.log('  PATCH (fix):     ', counts.patch);
  if (samples.patch.length) console.log('    ' + samples.patch.join('\n    '));
  console.log('  other (chore):   ', counts.other);
  console.log('---');
  console.log('Suggested bump:', bumpType || 'none (no feat/fix/breaking commits)');
  console.log('Next version:   ', next);

  if (apply && bumpType) {
    const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
    pkg.version = next;
    fs.writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + '\n');
    _sh(`git add package.json`);
    _sh(`git commit -m "chore(version): bump ${current} → ${next}"`);
    _sh(`git tag v${next}`);
    console.log('---');
    console.log('✓ Updated package.json to', next);
    console.log('✓ Committed + tagged v' + next);
    console.log('Run: git push && git push --tags');
  } else if (apply && !bumpType) {
    console.log('---');
    console.log('✗ Nothing to bump (no feat/fix/breaking commits since last tag)');
  }
}

main();