#!/usr/bin/env node
import { main } from '../lib/client/claude-compat.js';

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
