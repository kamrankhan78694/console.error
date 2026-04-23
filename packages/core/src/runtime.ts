import type { RuntimeEnv } from './types';

declare const __UNIFERR_RELEASE__: string | undefined;
declare const Deno: { version: { deno: string } } | undefined;

export function isNodeRuntime(): boolean {
  return typeof process !== 'undefined' && typeof process.versions?.node === 'string';
}

export function isBrowserRuntime(): boolean {
  return typeof window !== 'undefined' && typeof window.document !== 'undefined';
}

export function isDenoRuntime(): boolean {
  return typeof Deno !== 'undefined';
}

export function isWorkerRuntime(): boolean {
  return !isBrowserRuntime() && !isNodeRuntime() && !isDenoRuntime();
}

export function getRelease(override?: string): string | undefined {
  if (typeof override === 'string' && override.length > 0) {
    return override;
  }
  return typeof __UNIFERR_RELEASE__ === 'string' ? __UNIFERR_RELEASE__ : undefined;
}

export function resolveRuntimeEnv(release?: string): RuntimeEnv {
  const resolvedRelease = getRelease(release);

  if (isBrowserRuntime()) {
    const env: RuntimeEnv = {
      runtime: 'browser',
      url: window.location.href,
      userAgent: navigator.userAgent
    };
    if (resolvedRelease) {
      env.release = resolvedRelease;
    }
    return env;
  }

  if (isNodeRuntime()) {
    const env: RuntimeEnv = {
      runtime: 'node',
      nodeVersion: process.version
    };
    if (resolvedRelease) {
      env.release = resolvedRelease;
    }
    return env;
  }

  if (isDenoRuntime()) {
    const env: RuntimeEnv = { runtime: 'deno' };
    if (resolvedRelease) {
      env.release = resolvedRelease;
    }
    return env;
  }

  const env: RuntimeEnv = { runtime: 'worker' };
  if (resolvedRelease) {
    env.release = resolvedRelease;
  }
  return env;
}
