/**
 * End-to-end Bug2PR run: screen recording -> repro steps (Spark + SAM) ->
 * computer-use replay -> gated failing test -> fix loop -> local PR awaiting
 * sign-off. Emits progress events for the UI (and logs). The target app must
 * already be running with the buggy code checked out.
 */
import { readFile } from 'node:fs/promises';
import type { SpecAction } from '../lib/spec-actions.js';
import { providerFor } from '../lib/text-completion-providers.js';
import { pngDataUrl, timestamp } from '../lib/video-frames.js';
import type { TargetApp } from '../targets/target-apps.js';
import { extractReproSteps } from './extract-repro-steps.js';
import { fixLoop, type FixAttempt } from './fix-loop.js';
import { localizeBugFiles, searchTerms } from './localize-bug-files.js';
import { prepareGatedPr } from './open-gated-pr.js';
import type { Repro } from './repro-steps-schema.js';
import { reproduceBugToFailingTest } from './reproduce-bug-to-failing-test.js';
import type { SpecOutcome } from './run-repro-spec.js';

export type StageId = 'understand' | 'replay' | 'test' | 'fix' | 'pr';
export type Bug2PrEvent =
  | { type: 'stage'; stage: StageId; status: 'running' | 'done' | 'failed' | 'escalated'; detail?: string }
  | { type: 'log'; stage: StageId; message: string }
  | { type: 'interactions'; items: { start: string; end: string; x: number; y: number }[] }
  | { type: 'steps'; repro: Repro }
  | { type: 'turn'; turn: number; screenshot: string; actions: SpecAction[]; note: string }
  | { type: 'gate'; attempt: number; description: string; status: SpecOutcome['status']; message: string; spec: string }
  | { type: 'fixAttempt'; n: number; rootCause: string; files: string[]; problems: string[]; model: string }
  | { type: 'diff'; diff: string }
  | { type: 'pr'; branch?: string; commit?: string; title?: string; body?: string; reason: string }
  | { type: 'done'; status: 'pr-ready' | 'escalated' | 'failed'; seconds: number };

export async function runBug2Pr(bugId: string, video: string, app: TargetApp, emit: (e: Bug2PrEvent) => void): Promise<void> {
  const started = performance.now();
  const finish = (status: 'pr-ready' | 'escalated' | 'failed') => emit({ type: 'done', status, seconds: Math.round((performance.now() - started) / 1000) });

  // 1. Understand the video: SAM 3.1 cursor grounding + Muse Spark repro steps.
  emit({ type: 'stage', stage: 'understand', status: 'running' });
  const extraction = await extractReproSteps(video, 'grounded');
  emit({ type: 'interactions', items: extraction.interactions.map((i) => ({ start: timestamp(i.start), end: timestamp(i.end), x: Math.round(i.x), y: Math.round(i.y) })) });
  emit({ type: 'steps', repro: extraction.repro });
  emit({ type: 'stage', stage: 'understand', status: 'done', detail: `${extraction.repro.steps.length} steps, ${extraction.interactions.length} cursor interactions (${extraction.cursorFrames} frames tracked)` });

  // 2-3. Replay with computer use, then gate a failing test.
  emit({ type: 'stage', stage: 'replay', status: 'running' });
  let testStarted = false;
  let gateAttempts = 0;
  const failing = await reproduceBugToFailingTest(bugId, app, extraction.repro, extraction.interactions, {
    onTurn: (turn, png, actions, note) => emit({ type: 'turn', turn, screenshot: pngDataUrl(png), actions, note }),
    onAttempt: (a, spec) => {
      if (!testStarted) {
        testStarted = true;
        emit({ type: 'stage', stage: 'replay', status: 'done', detail: 'bug reproduced live' });
        emit({ type: 'stage', stage: 'test', status: 'running' });
      }
      emit({ type: 'gate', attempt: ++gateAttempts, description: a.assertion.description, status: a.outcome.status, message: a.outcome.message, spec });
    },
  });
  if (failing.status === 'not-reproduced') {
    emit({ type: 'stage', stage: 'replay', status: 'failed', detail: failing.reason });
    return finish('failed');
  }
  if (failing.status !== 'failing-test-ready') {
    emit({ type: 'stage', stage: 'test', status: 'escalated', detail: failing.reason });
    return finish('escalated');
  }
  emit({ type: 'stage', stage: 'test', status: 'done', detail: failing.reason });

  // 4. Localize + fix loop (Meta API or open weights, see text-completion-providers).
  const { model, provider } = providerFor('fix');
  emit({ type: 'stage', stage: 'fix', status: 'running', detail: `${model} via ${provider === 'baseten' ? 'Baseten (open weights)' : 'Meta Model API'}` });
  const terms = searchTerms(failing.actions, failing.assertion!);
  const files = await localizeBugFiles(app, extraction.repro, terms);
  emit({ type: 'log', stage: 'fix', message: `Candidate files: ${files.join(', ')}` });
  const fix = await fixLoop(
    app,
    extraction.repro,
    { file: failing.specFile!, assertLine: failing.assertLine!, config: 'playwright.repro.config.ts', failure: failing.stability[0]?.message ?? '' },
    files,
    terms,
    (a: FixAttempt, n) => emit({ type: 'fixAttempt', n, rootCause: a.rootCause, files: a.files, problems: a.problems, model }),
  );
  if (fix.status !== 'fixed') {
    emit({ type: 'stage', stage: 'fix', status: 'escalated', detail: `no verified fix after ${fix.attempts.length} attempts` });
    return finish('escalated');
  }
  emit({ type: 'diff', diff: fix.diff ?? '' });
  emit({ type: 'stage', stage: 'fix', status: 'done', detail: `fixed on attempt ${fix.attempts.length}` });

  // 5. Gated PR: local branch + PR body, waiting for human sign-off.
  emit({ type: 'stage', stage: 'pr', status: 'running' });
  const pr = await prepareGatedPr(app, bugId, extraction.repro, fix, failing.specFile!, { failsBefore: `${failing.stability.length}/${failing.stability.length}`, replayTurns: failing.replay.turns, video });
  const body = pr.bodyFile ? await readFile(pr.bodyFile, 'utf8') : undefined;
  emit({ type: 'pr', branch: pr.branch, commit: pr.commit, title: pr.title, body, reason: pr.reason });
  emit({ type: 'stage', stage: 'pr', status: pr.status === 'awaiting-sign-off' ? 'done' : 'escalated', detail: pr.reason });
  return finish(pr.status === 'awaiting-sign-off' ? 'pr-ready' : 'escalated');
}
