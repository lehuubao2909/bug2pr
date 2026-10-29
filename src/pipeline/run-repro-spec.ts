/**
 * Runs a generated spec with Playwright's JSON reporter and classifies the
 * outcome: passed, failed AT the expected-behaviour assertion (the bug), or
 * failed EARLIER (the reproduction itself broke). Only the second kind proves
 * the test captures the bug.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export type SpecOutcome = { status: 'passed' | 'failed-at-assertion' | 'failed-before-assertion' | 'error'; message: string; line?: number };

type JsonReport = {
  suites?: JsonSuite[];
  errors?: { message?: string }[];
};
type JsonSuite = { suites?: JsonSuite[]; specs?: { tests: { results: { status: string; errors?: { message?: string; location?: { file: string; line: number } }[] }[] }[] }[] };

function firstResult(suites: JsonSuite[] = []): { status: string; errors?: { message?: string; location?: { file: string; line: number } }[] } | undefined {
  for (const s of suites) {
    const r = s.specs?.[0]?.tests?.[0]?.results?.[0] ?? firstResult(s.suites);
    if (r) return r;
  }
  return undefined;
}

const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '');

export async function runReproSpec(specFile: string, config: string, assertLine: number): Promise<SpecOutcome> {
  let stdout = '';
  try {
    ({ stdout } = await run('npx', ['playwright', 'test', '-c', config, specFile, '--reporter=json', '--retries=0'], { maxBuffer: 20_000_000, timeout: 180_000 }));
  } catch (err) {
    stdout = (err as { stdout?: string }).stdout ?? ''; // non-zero exit on test failure
  }
  let report: JsonReport;
  try {
    report = JSON.parse(stdout) as JsonReport;
  } catch {
    return { status: 'error', message: stdout.slice(0, 500) || 'no JSON output' };
  }
  const result = firstResult(report.suites);
  if (!result) return { status: 'error', message: stripAnsi(report.errors?.[0]?.message ?? 'no test result').slice(0, 500) };
  if (result.status === 'passed') return { status: 'passed', message: 'test passed' };

  const error = result.errors?.[0];
  const line = error?.location?.line;
  // Keep only the deterministic part (assertion, locator, expected/received);
  // the call log and timeouts vary between runs.
  const message = stripAnsi(error?.message ?? result.status)
    .split(/\n\s*Call log:/)[0]!
    .split('\n')
    .filter((l) => !/^\s*Timeout:/.test(l))
    .join(' ')
    .replace(/\s+/g, ' ')
    .slice(0, 400);
  return { status: line === assertLine ? 'failed-at-assertion' : 'failed-before-assertion', message, line };
}
