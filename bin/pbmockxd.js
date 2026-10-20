#!/usr/bin/env node
'use strict';

// Foreground daemon entry. `pbmockx start` spawns this detached.
require('../dist/src/server/daemon').main().catch((e) => {
  console.error('[pbmockxd] fatal:', e && e.stack ? e.stack : e);
  process.exit(1);
});
