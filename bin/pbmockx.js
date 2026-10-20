#!/usr/bin/env node
'use strict';

// Thin CLI shell. All logic lives in dist/src/cli/index.js so it can be
// unit-tested and type-checked.
require('../dist/src/cli/index').main(process.argv.slice(2)).catch((e) => {
  console.error('Error:', e && e.message ? e.message : e);
  process.exit(1);
});
