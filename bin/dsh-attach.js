#!/usr/bin/env node
import { main } from '../lib/client/cli.js';

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
