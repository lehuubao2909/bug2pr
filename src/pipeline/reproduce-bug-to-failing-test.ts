/**
 * Phase 4 orchestration: repro steps -> computer-use replay -> expected
 * assertion -> generated spec -> verification gate.
 *
 * Gate (fixed point the agent cannot skip): the spec must fail AT the
 * assertion on the buggy app in 3 out of 3 runs. A rejected assertion goes
 * back to the model with the reason; after 3 rejections we escalate to a
 * person with everything collected so far.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SpecAction } from '../lib/spec-actions.js';
import type { TargetApp } from '../targets/target-apps.js';
import { codifyFailingTest } from './codify-failing-test.js';
import type { Interaction } from './detect-interactions-from-cursor-track.js';
import { proposeExpectedAssertion, type ExpectedAssertion } from './propose-expected-assertion.js';
import { replayWithComputerUse } from './replay-with-computer-use.js';
import type { Repro } from './repro-steps-schema.js';
import { runReproSpec, type SpecOutcome } from './run-repro-spec.js';

const MAX_ASSERTION_ATTEMPTS = 3;
const STABILITY_RUNS = 3;
const REPRO_CONFIG = 'playwright.repro.config.ts';

export type FailingTestResult = {
  status: 'failing-test-ready' | 'not-reproduced' | 'escalated';
  reason: string;
  specFile?: string;
  assertLine?: number;
  assertion?: ExpectedAssertion;
  actions: SpecAction[];
  replay: { reproduced: boolean; turns: number; stopReason: string; ms: number; report: string };
  attempts: { assertion: ExpectedAssertion; outcome: SpecOutcome }[];
  stability: SpecOutcome[];
};

/**
 * A failure only proves the bug if the assertion found its element and saw the
 * wrong value. "element(s) not found" means the locator is wrong (except for
 * toBeVisible, where a missing element IS the bug, e.g. a row that never shows).
 */
function capturesBug(outcome: SpecOutcome, assertion: ExpectedAssertion): boolean {
  if (outcome.status !== 'failed-at-assertion') return false;
  return assertion.check === 'toBeVisible' || !/element\(s\) not found/i.test(outcome.message);
}

/**
 * Sensitivity check for value assertions: run the spec WITHOUT the repro
 * actions. If it fails with the identical message, the assertion reads an
 * element the steps never touch (e.g. a same-named column header), so it
 * cannot be measuring the bug. Visibility checks are exempt: an element that
 * is absent before and after is a legitimate bug signal.
 */
async function sensitiveToSteps(app: TargetApp, id: string, repro: Repro, assertion: ExpectedAssertion, specFile: string, full: SpecOutcome): Promise<boolean> {
  if (assertion.check === 'toBeVisible' || assertion.check === 'changesAfterAction') return true;
  const spec = codifyFailingTest(app, `bug2pr: ${id}`, repro.expected, [], assertion);
  await writeFile(specFile, spec.source);
  const baseline = await runReproSpec(specFile, REPRO_CONFIG, spec.assertLines[0]);
  return baseline.message !== full.message;
}

/**
 * The agent may wander (retries, resets) before it reproduces the bug. Try
 * dropping leading actions, shortest suffix first, and keep the shortest
 * action list whose spec fails at the assertion with the SAME failure message
 * as the full replay (same wrong state, not just any failure).
 */
async function minimizeActions(app: TargetApp, id: string, repro: Repro, actions: SpecAction[], assertion: ExpectedAssertion, specFile: string, full: SpecOutcome): Promise<SpecAction[]> {
  if (actions.length <= 4) return actions;
  const capture = assertion.captureBeforeAction;
  for (let start = actions.length - 1; start > 0; start--) {
    if (capture !== undefined && start > capture) continue; // keep the capture point
    const shifted = capture !== undefined ? { ...assertion, captureBeforeAction: capture - start } : assertion;
    const spec = codifyFailingTest(app, `bug2pr: ${id}`, repro.expected, actions.slice(start), shifted);
    await writeFile(specFile, spec.source);
    const outcome = await runReproSpec(specFile, REPRO_CONFIG, spec.assertLines[0]);
    if (capturesBug(outcome, shifted) && outcome.message === full.message) {
      if (capture !== undefined) assertion.captureBeforeAction = capture - start;
      return actions.slice(start);
    }
  }
  return actions;
}

export async function reproduceBugToFailingTest(
  id: string,
  app: TargetApp,
  repro: Repro,
  interactions: Interaction[],
  hooks: {
    onTurn?: (turn: number, screenshot: Buffer, actions: SpecAction[], note: string) => void;
    onAttempt?: (attempt: { assertion: ExpectedAssertion; outcome: SpecOutcome }, specSource: string) => void;
  } = {},
): Promise<FailingTestResult> {
  const outDir = path.resolve('runs/replay', id);
  await mkdir(outDir, { recursive: true });
  const specFile = path.join(outDir, 'repro.spec.ts');

  const replay = await replayWithComputerUse(app, repro, interactions, { outDir, onTurn: hooks.onTurn });
  const summary = { reproduced: replay.reproduced, turns: replay.turns, stopReason: replay.stopReason, ms: replay.ms, report: replay.report };
  const base = { actions: replay.actions, replay: summary, attempts: [] as FailingTestResult['attempts'], stability: [] as SpecOutcome[] };
  if (!replay.reproduced) {
    await replay.close();
    return { ...base, status: 'not-reproduced', reason: `agent did not reproduce the bug (${replay.stopReason})` };
  }

  const feedback: string[] = [];
  try {
    for (let attempt = 1; attempt <= MAX_ASSERTION_ATTEMPTS; attempt++) {
      const assertion = await proposeExpectedAssertion(replay.page, repro, replay.actions, feedback);
      let spec = codifyFailingTest(app, `bug2pr: ${id}`, repro.expected, replay.actions, assertion);
      await writeFile(specFile, spec.source);
      const outcome = await runReproSpec(specFile, REPRO_CONFIG, spec.assertLines[0]);
      base.attempts.push({ assertion, outcome });
      hooks.onAttempt?.({ assertion, outcome }, spec.source);

      if (capturesBug(outcome, assertion) && !(await sensitiveToSteps(app, id, repro, assertion, specFile, outcome))) {
        feedback.push(`"${assertion.description}" fails identically even without the repro steps, so its locator points at an element the steps never change (likely a different element with the same name); target the element the bug affects`);
      } else if (capturesBug(outcome, assertion)) {
        base.actions = await minimizeActions(app, id, repro, replay.actions, assertion, specFile, outcome);
        spec = codifyFailingTest(app, `bug2pr: ${id}`, repro.expected, base.actions, assertion);
        await writeFile(specFile, spec.source);
        // Stability: the bug must show up every time, not by chance.
        for (let i = 0; i < STABILITY_RUNS; i++) base.stability.push(await runReproSpec(specFile, REPRO_CONFIG, spec.assertLines[0]));
        if (base.stability.every((o) => capturesBug(o, assertion))) {
          return { ...base, status: 'failing-test-ready', reason: `fails at the assertion ${STABILITY_RUNS}/${STABILITY_RUNS} runs (${base.actions.length}/${replay.actions.length} actions kept)`, specFile, assertLine: spec.assertLines[0], assertion };
        }
        feedback.push(`"${assertion.description}" was flaky: ${base.stability.map((o) => o.status).join(', ')}`);
        base.stability = [];
        base.actions = replay.actions;
      } else if (outcome.status === 'failed-at-assertion') {
        feedback.push(`"${assertion.description}" failed only because its locator matched no element (${outcome.message.slice(0, 160)}); target an element that exists and check its value`);
      } else if (outcome.status === 'passed') {
        feedback.push(`"${assertion.description}" PASSED on the buggy app, so it does not capture the bug`);
      } else {
        feedback.push(`"${assertion.description}" broke the test before/at a wrong line (${outcome.status}): ${outcome.message}`);
      }
    }
  } finally {
    await replay.close();
  }
  return { ...base, status: 'escalated', reason: `no assertion passed the gate after ${MAX_ASSERTION_ATTEMPTS} attempts`, specFile };
}
