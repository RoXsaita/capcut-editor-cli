#!/usr/bin/env node

import { main } from '../src/cli.mjs';

main(process.argv.slice(2)).catch(error => {
  process.stderr.write(`${error?.message || String(error)}\n`);
  // A failed transaction carries the reasons; without them the message is just a count.
  for (const item of error?.details || []) {
    process.stderr.write(`  ${item.level?.toUpperCase() || 'ERROR'} ${item.code || ''}: ${item.message}\n`);
  }
  if (process.env.CAPCUTCTL_STACK && error?.stack) process.stderr.write(`${error.stack}\n`);
  process.exitCode = error?.exitCode || 1;
});
