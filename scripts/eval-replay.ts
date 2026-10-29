/**
 * Evaluates phase 4 on every eval bug: replay the extracted steps with
 * computer use, produce a failing spec through the gate, then (eval-only,
 * using our knowledge of the fix) check the spec PASSES on fixed code.
 * Uses the grounded extraction saved by eval:extract when available.
 *
 * Usage: npm run eval:replay [-- <bug-id> ...]
 * Needs: shadcn-admin on :5173 and Actual on :3002 (bug branch checked out).
 */
import { execFileSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { extractReproSteps } from '../src/pipeline/extract-repro-steps.js';
import type { Interaction } from '../src/pipeline/detect-interactions-from-cursor-track.js';
import type { Repro } from '../src/pipeline/repro-steps-schema.js';
import { reproduceBugToFailingTest } from '../src/pipeline/reproduce-bug-to-failing-test.js';
import { runReproSpec } from '../src/pipeline/run-repro-spec.js';
import { targetApp } from '../src/targets/target-apps.js';
import { runDir, writeJson } from '../src/lib/write-run-artifact.js';

type Truth = { id: string; app: string; branch: string; upstream?: { fixCommit: string } };
const TARGET_DIRS: Record<string, string> = { 'shadcn-admin': path.resolve('../targets/shadcn-admin'), actual: path.resolve('../targets/actual') };
const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' }).toString();
const settle = () => new Promise((r) => setTimeout(r, 4000)); // let Vite hot-reload

async function loadExtraction(id: string): Promise<{ repro: Repro; interactions: Interaction[] }> {
  try {
    return JSON.parse(await readFile(`runs/eval-extraction/${id}.grounded.1.json`, 'utf8')) as { repro: Repro; interactions: Interaction[] };
  } catch {
    const r = await extractReproSteps(`eval/bugs/${id}/video.mp4`, 'grounded');
    return { repro: r.repro, interactions: r.interactions };
  }
}

/** Switch the target to fixed code, run fn, switch back to the bug. */
async function onFixedCode<T>(truth: Truth, fn: () => Promise<T>): Promise<T> {
  const dir = TARGET_DIRS[truth.app]!;
  if (truth.upstream) {
    const diff = git(dir, 'diff', `${truth.upstream.fixCommit}^1`, truth.upstream.fixCommit, '--', 'packages/desktop-client/src');
    execFileSync('git', ['-C', dir, 'apply'], { input: diff });
  } else {
    git(dir, 'checkout', '-q', 'main');
  }
  await settle();
  try {
    return await fn();
  } finally {
    if (truth.upstream) git(dir, 'checkout', '-q', '--', '.');
    else git(dir, 'checkout', '-q', truth.branch);
    await settle();
  }
}

async function main(): Promise<void> {
  const wanted = process.argv.slice(2);
  const ids = wanted.length ? wanted : (await readdir('eval/bugs')).sort();
  const outDir = await runDir('eval-replay');
  const rows = [];
  for (const id of ids) {
    const truth = JSON.parse(await readFile(`eval/bugs/${id}/truth.json`, 'utf8')) as Truth;
    git(TARGET_DIRS[truth.app]!, 'checkout', '-q', truth.branch);
    await settle();
    const { repro, interactions } = await loadExtraction(id);
    const result = await reproduceBugToFailingTest(id, targetApp(truth.app), repro, interactions);
    const onFixed = result.status === 'failing-test-ready'
      ? await onFixedCode(truth, () => runReproSpec(result.specFile!, 'playwright.repro.config.ts', result.assertLine!))
      : undefined;
    const row = {
      id,
      status: result.status,
      reproducedByAgent: result.replay.reproduced,
      turns: result.replay.turns,
      replaySec: Math.round(result.replay.ms / 1000),
      assertionAttempts: result.attempts.length,
      failsOnBug: result.stability.length ? `${result.stability.filter((o) => o.status === 'failed-at-assertion').length}/${result.stability.length}` : '-',
      passesOnFix: onFixed ? onFixed.status === 'passed' : '-',
      reason: result.reason,
    };
    rows.push(row);
    await writeJson(outDir, `${id}.json`, { ...result, onFixed });
    console.log(JSON.stringify(row));
  }
  if (rows[0]) console.table(rows.map(({ reason: _r, ...r }) => r));
  await writeJson(outDir, 'summary.json', rows);
  git(TARGET_DIRS['shadcn-admin']!, 'checkout', '-q', 'main');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
