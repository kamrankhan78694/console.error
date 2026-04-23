import { createGzip } from 'node:zlib';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync, type WriteStream } from 'node:fs';
import { dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';

import type { Transport, UnifErrEvent } from '@uniferr/core';
import { isNodeRuntime } from '@uniferr/core';

export interface FileTransportOptions {
  /** Absolute path of the active log file. */
  path: string;
  /** Rotate when the active file exceeds this many bytes. Default 10 MiB. */
  maxSize?: number;
  /** Number of rotated files to retain. Default 5. */
  maxFiles?: number;
  /** Gzip rotated files. Default true. */
  gzip?: boolean;
}

interface State {
  stream: WriteStream;
  bytes: number;
}

function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_k, v: unknown) => {
    if (typeof v === 'object' && v !== null) {
      if (seen.has(v as object)) return '[Circular]';
      seen.add(v as object);
    }
    if (typeof v === 'bigint') return v.toString();
    if (typeof v === 'function') return `[Function]`;
    return v;
  });
}

export function fileTransport(options: FileTransportOptions): Transport {
  if (!isNodeRuntime()) {
    throw new Error('@uniferr/transport-file requires a Node.js runtime');
  }

  const path = options.path;
  const maxSize = Math.max(1024, options.maxSize ?? 10 * 1024 * 1024);
  const maxFiles = Math.max(1, options.maxFiles ?? 5);
  const gzip = options.gzip ?? true;

  mkdirSync(dirname(path), { recursive: true });

  let state: State = openStream(path);
  // Serialise rotation so concurrent send() calls cannot interleave a rotate.
  let rotateChain: Promise<void> = Promise.resolve();

  const exitHandler = (): void => {
    try {
      state.stream.end();
    } catch {
      // ignore
    }
  };
  process.on('exit', exitHandler);

  function openStream(filePath: string): State {
    const bytes = existsSync(filePath) ? statSync(filePath).size : 0;
    const stream = createWriteStream(filePath, { flags: 'a' });
    return { stream, bytes };
  }

  async function rotate(): Promise<void> {
    // Close current stream before moving the file.
    await new Promise<void>((resolve) => state.stream.end(() => resolve()));

    // Shift older rotations: .N → .N+1, dropping anything past maxFiles.
    for (let i = maxFiles - 1; i >= 1; i -= 1) {
      const src = gzip ? `${path}.${i}.gz` : `${path}.${i}`;
      const dst = gzip ? `${path}.${i + 1}.gz` : `${path}.${i + 1}`;
      if (!existsSync(src)) continue;
      if (i + 1 > maxFiles) {
        try { unlinkSync(src); } catch { /* best-effort: rotation must never crash the host */ }
      } else {
        try { renameSync(src, dst); } catch { /* best-effort: rotation must never crash the host */ }
      }
    }

    // Move active file to .1 (or .1.gz after compression).
    if (existsSync(path)) {
      const intermediate = `${path}.1`;
      try {
        renameSync(path, intermediate);
      } catch {
        // If rename fails (e.g. cross-device), give up rotation gracefully —
        // the active stream will simply continue writing to the new file we
        // open below; we never want a logging side-channel to crash the app.
      }
      if (gzip && existsSync(intermediate)) {
        try {
          await pipeline(createReadStream(intermediate), createGzip(), createWriteStream(`${path}.1.gz`));
          unlinkSync(intermediate);
        } catch {
          // Leave the .1 file in place if compression fails.
        }
      }
    }

    state = openStream(path);
  }

  return {
    send(event: UnifErrEvent): Promise<void> {
      const line = safeStringify(event) + '\n';
      const buffer = Buffer.from(line, 'utf8');

      const writePromise = new Promise<void>((resolve) => {
        state.stream.write(buffer, () => resolve());
      });
      state.bytes += buffer.byteLength;

      if (state.bytes >= maxSize) {
        rotateChain = rotateChain.then(() => rotate()).catch(() => undefined);
        return rotateChain.then(() => writePromise);
      }
      return writePromise;
    },
    async flush(): Promise<void> {
      await rotateChain;
      await new Promise<void>((resolve) => {
        if (state.stream.writableNeedDrain) {
          state.stream.once('drain', () => resolve());
        } else {
          resolve();
        }
      });
      process.off('exit', exitHandler);
      await new Promise<void>((resolve) => state.stream.end(() => resolve()));
    }
  };
}
