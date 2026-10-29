/**
 * Small helpers for saving run artifacts (JSON results, screenshots) under
 * runs/<name>/ and for timing async steps.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const RUNS_DIR = path.resolve('runs');

export async function runDir(name: string): Promise<string> {
  const dir = path.join(RUNS_DIR, name);
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function writeJson(dir: string, file: string, data: unknown): Promise<string> {
  const target = path.join(dir, file);
  await writeFile(target, `${JSON.stringify(data, null, 2)}\n`);
  return target;
}

/** Runs fn and returns its result together with elapsed milliseconds. */
export async function timed<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const start = performance.now();
  const result = await fn();
  return { result, ms: Math.round(performance.now() - start) };
}
