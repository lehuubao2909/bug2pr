/**
 * Evaluates phase 5 on every bug that produced a gated failing test in
 * eval:replay: localize files, run the fix loop, then (eval-only) validate the
 * agent's fix against INDEPENDENT ground truth (our gold spec for seeded bugs,
 * the upstream PR's own e2e test for the real Actual bug), and finally commit
 * a local PR branch awaiting sign-off. Nothing is pushed.
 *
 * Usage: npm run eval:fix [-- <bug-id> ...]
 */
import { execFileSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fixLoop } from '../src/pipeline/fix-loop.js';
import { localizeBugFiles, searchTerms } from '../src/pipeline/localize-bug-files.js';
import { prepareGatedPr } from '../src/pipeline/open-gated-pr.js';
import type { FailingTestResult } from '../src/pipeline/reproduce-bug-to-failing-test.js';
import type { Repro } from '../src/pipeline/repro-steps-schema.js';
import { runRegressionChecks } from '../src/pipeline/run-regression-checks.js';
import { targetApp, type TargetApp } from '../src/targets/target-apps.js';
import { runDir, writeJson } from '../src/lib/write-run-artifact.js';

type Truth = { id: string; app: string; branch: string; fixFiles: string[]; upstream?: { fixCommit: string } };
const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' }).toString();
const settle = () => new Promise((r) => setTimeout(r, 4000));

/** Independent check that the agent's fix really fixes the bug (eval-only knowledge). */
async function groundTruthPasses(app: TargetApp, truth: Truth): Promise<boolean> {
  if (!truth.upstream) {
    const [r] = await runRegressionChecks([{ cmd: 'npx', args: ['playwright', 'test', '-c', 'playwright.eval.config.ts', `eval/bugs/${truth.id}`], cwd: process.cwd() }]);
    return !!r?.ok;
  }
  // Real bug: run the upstream PR's own e2e test against the agent's fix.
  const testFiles = ['packages/desktop-client/e2e/accounts.test.ts', 'packages/desktop-client/e2e/page-models/account-page.ts'];
  const diff = git(app.repoDir, 'diff', `${truth.upstream.fixCommit}^1`, truth.upstream.fixCommit, '--', ...testFiles);
  execFileSync('git', ['-C', app.repoDir, 'apply'], { input: diff });
  try {
    const [r] = await runRegressionChecks([{ ...app.regression[0]!, args: ['playwright', 'test', 'e2e/accounts.test.ts', '-g', 'running balance', '--retries=0', '--reporter=line'] }]);
    return !!r?.ok;
  } finally {
    git(app.repoDir, 'checkout', '-q', '--', ...testFiles);
  }
}

async function main(): Promise<void> {
  const wanted = process.argv.slice(2);
  const ids = wanted.length ? wanted : (await readdir('eval/bugs')).sort();
  const outDir = await runDir('eval-fix');
  const rows = [];
  for (const id of ids) {
    const replay = JSON.parse(await readFile(`runs/eval-replay/${id}.json`, 'utf8')) as FailingTestResult;
    if (replay.status !== 'failing-test-ready') {
      rows.push({ id, status: 'skipped', reason: `phase 4 ${replay.status}` });
      continue;
    }
    const truth = JSON.parse(await readFile(`eval/bugs/${id}/truth.json`, 'utf8')) as Truth;
    const app = targetApp(truth.app);
    const { repro } = JSON.parse(await readFile(`runs/eval-extraction/${id}.grounded.1.json`, 'utf8')) as { repro: Repro };
    git(app.repoDir, 'checkout', '-q', truth.branch);
    await settle();

    const terms = searchTerms(replay.actions, replay.assertion!);
    const files = await localizeBugFiles(app, repro, terms);
    const failure = replay.stability[0]?.message ?? '';
    const fix = await fixLoop(app, repro, { file: replay.specFile!, assertLine: replay.assertLine!, config: 'playwright.repro.config.ts', failure }, files, terms);

    const truthOk = fix.status === 'fixed' ? await groundTruthPasses(app, truth) : undefined;
    const touched = fix.attempts.at(-1)?.files ?? [];
    const pr = fix.status === 'fixed'
      ? await prepareGatedPr(app, id, repro, fix, replay.specFile!, { failsBefore: `${replay.stability.length}/${replay.stability.length}`, replayTurns: replay.replay.turns, video: `eval/bugs/${id}/video.mp4` })
      : undefined;
    git(app.repoDir, 'checkout', '-q', truth.branch); // leave the app on the bug for further runs
    await settle();

    const row = {
      id,
      status: fix.status,
      localizedHit: files.some((f) => truth.fixFiles.includes(f)),
      attempts: fix.attempts.length,
      fixedFilesMatchTruth: touched.length > 0 && touched.every((f) => truth.fixFiles.includes(f)),
      groundTruthPasses: truthOk ?? '-',
      prBranch: pr?.status === 'awaiting-sign-off' ? `${pr.branch}@${pr.commit}` : pr?.reason ?? '-',
      fixSec: Math.round(fix.ms / 1000),
      rootCause: fix.rootCause ?? fix.attempts.at(-1)?.problems.join(' | ').slice(0, 200),
    };
    rows.push(row);
    await writeJson(outDir, `${id}.json`, { files, terms, fix, truthOk, pr });
    console.log(JSON.stringify(row));
  }
  await writeJson(outDir, 'summary.json', rows);
  git(targetApp('shadcn-admin').repoDir, 'checkout', '-q', 'main');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
