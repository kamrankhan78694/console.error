import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createEvent } from '@uniferr/core';
import { fileTransport } from '../src/index';

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uniferr-file-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('fileTransport', () => {
  it('appends NDJSON lines and flush() finalises the file', async () => {
    const file = join(dir, 'errors.log');
    const t = fileTransport({ path: file });
    await t.send(createEvent({ level: 'error', args: ['a'] }));
    await t.send(createEvent({ level: 'warn', args: ['b'] }));
    await t.flush?.();

    const lines = readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).message).toBe('a');
    expect(JSON.parse(lines[1]!).message).toBe('b');
  });

  it('rotates when the active file exceeds maxSize', async () => {
    const file = join(dir, 'errors.log');
    const t = fileTransport({ path: file, maxSize: 200, gzip: false });
    for (let i = 0; i < 10; i += 1) {
      await t.send(createEvent({ level: 'error', args: ['x'.repeat(80)] }));
    }
    await t.flush?.();

    const entries = readdirSync(dir);
    // Expect the active file plus at least one rotated file (errors.log.1).
    expect(entries.some((e) => e === 'errors.log')).toBe(true);
    expect(entries.some((e) => e.startsWith('errors.log.'))).toBe(true);
  });

  it('produces gzipped rotations when gzip is enabled', async () => {
    const file = join(dir, 'errors.log');
    const t = fileTransport({ path: file, maxSize: 200, gzip: true });
    for (let i = 0; i < 10; i += 1) {
      await t.send(createEvent({ level: 'error', args: ['y'.repeat(80)] }));
    }
    await t.flush?.();

    const entries = readdirSync(dir);
    expect(entries.some((e) => e.endsWith('.gz'))).toBe(true);
  });
});
