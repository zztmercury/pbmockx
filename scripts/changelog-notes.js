#!/usr/bin/env node
'use strict';

/**
 * Extract the release-notes section for one version from CHANGELOG.md.
 *
 *   node scripts/changelog-notes.js                 # print section for VERSION
 *   node scripts/changelog-notes.js --version 1.0.0 # print section for an explicit version
 *   node scripts/changelog-notes.js --check         # exit 1 unless the section exists
 *   node scripts/changelog-notes.js --out notes.md  # write to a file (used by CI)
 *
 * A section starts at `## [<version>]` and ends at the next `## [` heading.
 * Missing or empty sections are an error: the release workflow treats CHANGELOG
 * as required so `git tag` never ships without notes.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function usage() {
  console.error('usage: changelog-notes [--version <x.y.z>] [--check] [--out <file>]');
  process.exit(2);
}

function parseArgs(argv) {
  const args = { version: '', check: false, out: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') args.check = true;
    else if (a === '--version') args.version = argv[++i] || '';
    else if (a === '--out') args.out = argv[++i] || '';
    else if (a === '-h' || a === '--help') usage();
    else usage();
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const version = (args.version || fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf-8')).trim();
  if (!version) {
    console.error('changelog-notes: empty version');
    process.exit(1);
  }

  const heading = `## [${version}]`;
  const changelog = path.join(ROOT, 'CHANGELOG.md');
  const lines = fs.readFileSync(changelog, 'utf-8').split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(heading));
  if (start === -1) {
    console.error(`changelog-notes: no "${heading}" section in CHANGELOG.md`);
    console.error(`changelog-notes: add "${heading} - YYYY-MM-DD" before releasing ${version}`);
    process.exit(1);
  }

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## [')) { end = i; break; }
  }

  const body = lines.slice(start + 1, end).join('\n').trim();
  if (!body) {
    console.error(`changelog-notes: "${heading}" section is empty`);
    process.exit(1);
  }

  if (args.check) {
    console.log(`changelog-notes: OK — ${heading} (${body.split('\n').length} lines)`);
    return;
  }
  if (args.out) {
    fs.writeFileSync(args.out, body + '\n');
    console.log(`changelog-notes: wrote ${args.out} (${body.split('\n').length} lines)`);
    return;
  }
  process.stdout.write(body + '\n');
}

main();
