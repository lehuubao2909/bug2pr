/**
 * Runs the target's own regression commands (typecheck, existing tests).
 * A fix only counts if all of them stay green.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Command } from '../targets/target-apps.js';

const run = promisify(execFile);

export type CheckResult = { command: string; ok: boolean; tail: string; ms: number };

export async function runRegressionChecks(commands: Command[]): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const c of commands) {
    const started = performance.now();
    const label = `${c.cmd} ${c.args.join(' ')}`;
    try {
      const { stdout } = await run(c.cmd, c.args, { cwd: c.cwd, env: { ...process.env, ...c.env, CI: '' }, maxBuffer: 50_000_000, timeout: 300_000 });
      results.push({ command: label, ok: true, tail: stdout.slice(-300), ms: Math.round(performance.now() - started) });
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message: string };
      const tail = `${e.stdout ?? ''}\n${e.stderr ?? ''}`.replace(/\u001b\[[0-9;]*m/g, '').slice(-1500) || e.message;
      results.push({ command: label, ok: false, tail, ms: Math.round(performance.now() - started) });
      break; // later checks are pointless once one fails
    }
  }
  return results;
}
