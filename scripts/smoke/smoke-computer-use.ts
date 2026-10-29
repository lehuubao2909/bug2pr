/**
 * Smoke test 2/3: can Muse Wonder drive a real browser through the
 * computer-use tool and reproduce the fixture bug? We run Playwright locally,
 * send screenshots, execute the returned actions and stop after MAX_STEPS.
 * Pending safety checks are never auto-acknowledged: the run stops instead.
 *
 * Usage: npm run smoke:computer-use
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { metaClient, models } from '../../src/lib/meta-model-client.js';
import { executeAction, screenshotDataUrl, type ComputerAction } from '../../src/lib/execute-computer-actions.js';
import { runDir, writeJson } from '../../src/lib/write-run-artifact.js';
import { canAcknowledge, type SafetyCheck } from '../../src/lib/computer-use-safety-policy.js';

const MAX_STEPS = 15;
const APP = pathToFileURL(path.resolve('fixtures/buggy-todo-app/index.html')).href;
const TASK = `You are testing a todo web app shown in the screenshot.
1. Add a todo "Buy milk" and a todo "Call the bank".
2. Tick "Buy milk" as done.
3. Look at the "items left" counter and report its exact text, and whether it is correct.
Finish with a short plain-text report.`;

type ComputerCall = {
  type: 'computer_call';
  call_id: string;
  actions: ComputerAction[];
  pending_safety_checks?: SafetyCheck[];
};
type ResponseLike = { id: string; output: { type: string }[]; output_text?: string; usage?: unknown; status?: string };

async function main(): Promise<void> {
  const dir = await runDir('smoke-computer-use');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(APP);

  const log: unknown[] = [];
  const acknowledged: string[] = [];
  const started = performance.now();
  let response = (await metaClient().responses.create({
    model: models.computerUse,
    tools: [{ type: 'computer' }],
    input: [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: TASK },
          { type: 'input_image', image_url: await screenshotDataUrl(page) },
        ],
      },
    ],
  } as never)) as unknown as ResponseLike;

  let steps = 0;
  let stopReason = 'model finished';
  for (; steps < MAX_STEPS; steps++) {
    const call = response.output.find((o) => o.type === 'computer_call') as ComputerCall | undefined;
    if (!call) break;
    const checks = call.pending_safety_checks ?? [];
    if (!canAcknowledge(checks, page.url())) {
      stopReason = `pending safety checks: ${JSON.stringify(checks.map((c) => c.code))}`;
      break;
    }
    acknowledged.push(...checks.map((c) => c.code));
    for (const action of call.actions) await executeAction(page, action);
    await page.waitForTimeout(300); // let the UI settle
    await writeFile(path.join(dir, `step-${String(steps + 1).padStart(2, '0')}.png`), await page.screenshot());
    log.push({ step: steps + 1, actions: call.actions });
    console.log(`step ${steps + 1}: ${call.actions.map((a) => a.type).join(', ')}`);

    response = (await metaClient().responses.create({
      model: models.computerUse,
      tools: [{ type: 'computer' }],
      previous_response_id: response.id,
      input: [
        {
          type: 'computer_call_output',
          call_id: call.call_id,
          acknowledged_safety_checks: checks,
          output: { type: 'computer_screenshot', image_url: await screenshotDataUrl(page) },
        },
      ],
    } as never)) as unknown as ResponseLike;
  }
  if (steps >= MAX_STEPS) stopReason = `step budget (${MAX_STEPS}) reached`;

  const counter = await page.locator('#counter').textContent();
  await browser.close();
  const file = await writeJson(dir, 'result.json', {
    model: models.computerUse,
    steps,
    stopReason,
    totalMs: Math.round(performance.now() - started),
    finalCounterInDom: counter,
    acknowledgedSafetyChecks: acknowledged.length,
    finalReport: response.output_text,
    lastUsage: response.usage,
    log,
  });
  console.log(`\nStop: ${stopReason}\nDOM counter: ${counter}\nModel report: ${response.output_text}\nSaved ${file}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
