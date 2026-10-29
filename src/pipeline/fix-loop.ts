/**
 * Phase 5 fix loop. Each attempt starts from the clean buggy tree:
 * Muse Wonder proposes search/replace edits for the shortlisted files, we
 * apply them, let the dev server hot-reload, and the attempt only counts when
 * (1) the generated failing test now passes and (2) the target's own
 * regression checks stay green. Failures go back to the model as feedback.
 */
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { metaClient, models } from '../lib/meta-model-client.js';
import type { TargetApp } from '../targets/target-apps.js';
import { parseModelJson, type Repro } from './repro-steps-schema.js';
import { runRegressionChecks, type CheckResult } from './run-regression-checks.js';
import { runReproSpec, type SpecOutcome } from './run-repro-spec.js';
import { applyEdits, sourceContext } from './source-context-and-edits.js';

const MAX_ATTEMPTS = 4;
const HMR_SETTLE_MS = 4000;

const FixSchema = z.object({
  title: z.string().max(90),
  rootCause: z.string(),
  edits: z.array(z.object({ file: z.string(), search: z.string(), replace: z.string() })).min(1),
});

export type FixAttempt = { rootCause: string; files: string[]; problems: string[]; spec?: SpecOutcome; checks: CheckResult[] };
export type FixResult = { status: 'fixed' | 'escalated'; title?: string; rootCause?: string; diff?: string; attempts: FixAttempt[]; ms: number };

const PROMPT = `You fix a bug in a web app repository. A Playwright regression test reproduces it and currently FAILS.
Make the smallest correct change in the application source so the test passes, without breaking anything else.
Never edit tests. Return ONLY JSON:
{"title":"conventional commit subject, e.g. fix(pagination): go to the real last page","rootCause":"one or two sentences","edits":[{"file":"path as given","search":"exact existing text (several full lines, unique in the file, no line numbers)","replace":"new text"}]}`;

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' }).toString();
const settle = () => new Promise((r) => setTimeout(r, HMR_SETTLE_MS));

export async function fixLoop(
  app: TargetApp,
  repro: Repro,
  spec: { file: string; assertLine: number; config: string; failure: string },
  files: string[],
  terms: string[],
): Promise<FixResult> {
  const started = performance.now();
  const testSource = await readFile(spec.file, 'utf8');
  const attempts: FixAttempt[] = [];

  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
    git(app.repoDir, 'checkout', '-q', '--', '.'); // every attempt starts from the buggy tree
    const context = await sourceContext(app.repoDir, files, terms);
    const history = attempts.map((a, n) => `Attempt ${n + 1} (${a.rootCause}) was rejected: ${a.problems.join(' | ')}`).join('\n');
    const response = (await metaClient().responses.create({
      model: models.fix,
      input: [{ role: 'user', content: [
        { type: 'input_text', text: PROMPT },
        { type: 'input_text', text: `Bug report: expected "${repro.expected}", actual "${repro.actual}".` },
        { type: 'input_text', text: `Failing test:\n${testSource}\nCurrent failure: ${spec.failure}` },
        ...(history ? [{ type: 'input_text', text: history }] : []),
        { type: 'input_text', text: `Source files:\n${context}` },
      ] }],
    } as never)) as unknown as { output_text: string };

    let proposal: z.infer<typeof FixSchema>;
    try {
      proposal = FixSchema.parse(parseModelJson(response.output_text));
    } catch (err) {
      attempts.push({ rootCause: '(unparseable)', files: [], problems: [`invalid JSON: ${String(err).slice(0, 200)}`], checks: [] });
      continue;
    }
    const attempt: FixAttempt = { rootCause: proposal.rootCause, files: [...new Set(proposal.edits.map((e) => e.file))], problems: [], checks: [] };
    attempts.push(attempt);

    attempt.problems = await applyEdits(app.repoDir, files, proposal.edits);
    if (attempt.problems.length) continue;

    await settle();
    attempt.spec = await runReproSpec(spec.file, spec.config, spec.assertLine);
    if (attempt.spec.status !== 'passed') {
      attempt.problems.push(`regression test still fails (${attempt.spec.status}): ${attempt.spec.message}`);
      continue;
    }
    attempt.checks = await runRegressionChecks(app.regression);
    const broken = attempt.checks.find((c) => !c.ok);
    if (broken) {
      attempt.problems.push(`existing check failed: ${broken.command}\n${broken.tail.slice(-800)}`);
      continue;
    }
    return { status: 'fixed', title: proposal.title, rootCause: proposal.rootCause, diff: git(app.repoDir, 'diff'), attempts, ms: Math.round(performance.now() - started) };
  }

  git(app.repoDir, 'checkout', '-q', '--', '.');
  await settle();
  return { status: 'escalated', attempts, ms: Math.round(performance.now() - started) };
}
