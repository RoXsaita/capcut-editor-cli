#!/usr/bin/env node

import { main } from '../src/cli.mjs';

main(process.argv.slice(2)).catch(error => {
  process.stderr.write(`${error?.message || String(error)}\n`);
  // A failed transaction carries the reasons; without them the message is just a count.
  // `details` is an array of validation issues for VALIDATION_FAILED / POST_WRITE_VALIDATION,
  // but a plain object for ROLLED_BACK ({snapshot}), CAPCUT_RUNNING (process state) and others.
  // Iterating it blindly threw a TypeError that buried the real message under a stack trace —
  // worst on rollback, exactly when you most need to be told which snapshot saved you.
  const details = error?.details;
  if (Array.isArray(details)) {
    for (const item of details) {
      process.stderr.write(`  ${item?.level?.toUpperCase() || 'ERROR'} ${item?.code || ''}: ${item?.message ?? item}\n`);
    }
  } else if (details && typeof details === 'object') {
    for (const [key, value] of Object.entries(details)) {
      if (value == null) continue;
      process.stderr.write(`  ${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}\n`);
    }
  }
  if (process.env.CAPCUTCTL_STACK && error?.stack) process.stderr.write(`${error.stack}\n`);
  process.exitCode = error?.exitCode ?? 1;
});
