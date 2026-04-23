#!/usr/bin/env node
// Bundle-size budget enforcement for @uniferr/core.
// Fails (exit 1) if the gzipped ESM bundle exceeds the configured budget.
import { readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { resolve } from 'node:path';

const BUDGET_BYTES = Number(process.env.UNIFERR_CORE_BUDGET ?? 6 * 1024); // 6 KiB

const target = resolve(process.cwd(), 'packages/core/dist/index.js');

try {
  statSync(target);
} catch {
  console.error(`size-check: missing build artefact at ${target}. Run \`pnpm build\` first.`);
  process.exit(1);
}

const raw = readFileSync(target);
const gz = gzipSync(raw, { level: 9 });

const rawKb = (raw.byteLength / 1024).toFixed(2);
const gzKb = (gz.byteLength / 1024).toFixed(2);
const budgetKb = (BUDGET_BYTES / 1024).toFixed(2);

console.log(`@uniferr/core  raw=${rawKb} KB  gzip=${gzKb} KB  budget=${budgetKb} KB`);

if (gz.byteLength > BUDGET_BYTES) {
  console.error(
    `❌ Bundle-size budget exceeded: ${gz.byteLength} B > ${BUDGET_BYTES} B`
  );
  process.exit(1);
}
console.log('✅ Bundle-size budget respected.');
