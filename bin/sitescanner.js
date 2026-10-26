#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

// .env in the working folder; variables already set in the shell win.
const envFile = path.resolve(process.env.SITESCANNER_HOME || process.cwd(), '.env');
if (fs.existsSync(envFile) && typeof process.loadEnvFile === 'function') process.loadEnvFile(envFile);

const { main } = await import('../src/cli.js');

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
