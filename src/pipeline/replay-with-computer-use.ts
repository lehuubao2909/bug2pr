/**
 * Replays extracted repro steps in a real browser with Meta computer use.
 * The agent sees screenshots (plus an ARIA snapshot and the click spots seen
 * in the video); every action it takes is also recorded as a stable
 * SpecAction (role/name locators, not pixels) so it can become a test.
 * The browser stays open afterwards for assertion checks; call close().
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { canAcknowledge, type SafetyCheck } from '../lib/computer-use-safety-policy.js';
import { executeAction, screenshotDataUrl, toPlaywrightKey, type ComputerAction } from '../lib/execute-computer-actions.js';
import { metaClient, models } from '../lib/meta-model-client.js';
import { runAction, type SpecAction } from '../lib/spec-actions.js';
import { locatorAtPoint, locatorOfFocused } from '../lib/stable-locator-at-point.js';
import type { TargetApp } from '../targets/target-apps.js';
import type { Interaction } from './detect-interactions-from-cursor-track.js';
import type { Repro } from './repro-steps-schema.js';

export type ReplayResult = {
  reproduced: boolean;
  report: string;
  actions: SpecAction[];
  turns: number;
  stopReason: string;
  ms: number;
  page: Page;
  close: () => Promise<void>;
};

type ComputerCall = { type: 'computer_call'; call_id: string; actions: ComputerAction[]; pending_safety_checks?: SafetyCheck[] };
type ResponseLike = { id: string; output: { type: string }[]; output_text?: string };

const task = (repro: Repro, interactions: Interaction[], aria: string) => `You are a QA engineer reproducing a bug report in the browser shown in the screenshot.
The app is already open in the state where the recording started.
Steps seen in the user's screen recording:
${JSON.stringify(repro.steps, null, 1)}
Expected: ${repro.expected}
Actual (the bug): ${repro.actual}
${interactions.length ? `Click spots in the recording (same window size, pixels): ${interactions.map((i, n) => `#${n} (${Math.round(i.x)},${Math.round(i.y)})`).join(', ')}. Data in the app may differ from the video; prefer the same kind of element over the exact pixel.` : ''}
Accessibility tree of the page (truncated):
${aria}
Perform the steps one at a time, in order, and check the result after each. Do not reload, reset filters or navigate away unless a step says so; if an attempt goes wrong, redo only the steps needed. Stop as soon as the bug is visible.
When done, reply with a plain-text report whose first line is exactly "REPRODUCED: yes" or "REPRODUCED: no", then the evidence (quote on-screen values).`;

/** Records a recorder-friendly SpecAction for an agent action, before it is executed. */
async function recordAction(page: Page, action: ComputerAction): Promise<SpecAction | undefined> {
  switch (action.type) {
    case 'click':
    case 'double_click': {
      const locator = await locatorAtPoint(page, action.x, action.y);
      return locator ? { kind: 'click', locator } : undefined;
    }
    case 'type':
      return { kind: 'type', text: action.text };
    case 'keypress':
      return { kind: 'press', key: toPlaywrightKey(action.keys) };
    case 'scroll':
      return { kind: 'scroll', dx: action.scroll_x, dy: action.scroll_y };
    default:
      return undefined; // move / wait / screenshot / drag carry no test meaning
  }
}

export async function replayWithComputerUse(
  app: TargetApp,
  repro: Repro,
  interactions: Interaction[],
  opts: { outDir: string; maxTurns?: number; onTurn?: (turn: number, screenshot: Buffer, actions: SpecAction[], note: string) => void },
): Promise<ReplayResult> {
  const maxTurns = opts.maxTurns ?? 25;
  const started = performance.now();
  const browser: Browser = await chromium.launch();
  const page = await browser.newPage({ viewport: app.viewport });
  const close = async () => browser.close();
  await page.goto(app.url);
  for (const step of app.setup) await runAction(page, step);
  await page.waitForTimeout(500);

  const aria = (await page.locator('body').ariaSnapshot()).slice(0, 6000);
  const create = (body: object) => metaClient().responses.create({ model: models.computerUse, tools: [{ type: 'computer' }], ...body } as never) as unknown as Promise<ResponseLike>;
  let response = await create({
    input: [{ role: 'user', content: [{ type: 'input_text', text: task(repro, interactions, aria) }, { type: 'input_image', image_url: await screenshotDataUrl(page) }] }],
  });

  const actions: SpecAction[] = [];
  let turns = 0;
  let stopReason = 'agent finished';
  for (; turns < maxTurns; turns++) {
    const call = response.output.find((o) => o.type === 'computer_call') as ComputerCall | undefined;
    if (!call) break;
    const checks = call.pending_safety_checks ?? [];
    if (!canAcknowledge(checks, page.url())) {
      stopReason = `safety check needs a person: ${checks.map((c) => c.code).join(', ')}`;
      break;
    }
    const turnActions: SpecAction[] = [];
    for (const action of call.actions) {
      const recorded = await recordAction(page, action);
      await executeAction(page, action);
      // A click that focused a text field is better replayed by focusing that field.
      if (recorded?.kind === 'click' && action.type === 'click') {
        const focused = await locatorOfFocused(page);
        if (focused && ['textbox', 'combobox'].includes((focused as { role?: string }).role ?? '')) recorded.locator = focused;
      }
      if (recorded) {
        actions.push(recorded);
        turnActions.push(recorded);
      }
    }
    await page.waitForTimeout(300);
    const shot = await page.screenshot();
    await writeFile(path.join(opts.outDir, `replay-${String(turns + 1).padStart(2, '0')}.png`), shot);
    opts.onTurn?.(turns + 1, shot, turnActions, call.actions.map((a) => a.type).join(', '));
    response = await create({
      previous_response_id: response.id,
      input: [{ type: 'computer_call_output', call_id: call.call_id, acknowledged_safety_checks: checks, output: { type: 'computer_screenshot', image_url: await screenshotDataUrl(page) } }],
    });
  }
  if (turns >= maxTurns) stopReason = `turn budget (${maxTurns}) reached`;

  const report = response.output_text ?? '';
  return {
    reproduced: /^\s*REPRODUCED:\s*yes/im.test(report),
    report,
    actions,
    turns,
    stopReason,
    ms: Math.round(performance.now() - started),
    page,
    close,
  };
}
