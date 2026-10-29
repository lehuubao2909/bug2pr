/**
 * Asks Muse Spark for ONE assertion that encodes the EXPECTED (correct)
 * behaviour, in a small checked DSL instead of free-form code. Because the
 * bug is present, a good assertion must fail right now; the caller verifies
 * that by running the generated spec and feeds failures back here.
 */
import { z } from 'zod';
import type { Page } from 'playwright';
import { screenshotDataUrl } from '../lib/execute-computer-actions.js';
import { metaClient, models } from '../lib/meta-model-client.js';
import type { SpecAction } from '../lib/spec-actions.js';
import { parseModelJson, type Repro } from './repro-steps-schema.js';

const Locator = z.object({
  by: z.enum(['role', 'testId', 'placeholder', 'text', 'css']),
  role: z.string().optional(),
  name: z.string().optional(),
  value: z.string().optional(),
  exact: z.boolean().optional(),
  nth: z.number().int().optional(),
  within: z.object({ locator: z.object({ by: z.enum(['role', 'testId', 'placeholder', 'text', 'css']), role: z.string().optional(), name: z.string().optional(), value: z.string().optional() }), hasText: z.string().optional() }).optional(),
});

export const AssertionSchema = z.object({
  description: z.string(),
  locator: Locator,
  check: z.enum(['toBeVisible', 'toHaveText', 'toContainText', 'toHaveCount', 'toBeChecked', 'changesAfterAction']),
  value: z.union([z.string(), z.number()]).optional(),
  captureBeforeAction: z.number().int().optional(),
});
export type ExpectedAssertion = z.infer<typeof AssertionSchema>;

const PROMPT = `You write the final assertion of a regression test for a bug that was just reproduced in the browser (screenshot attached).
The assertion must describe the EXPECTED correct behaviour, so it FAILS now (bug present) and PASSES once fixed.
Return ONLY JSON:
{"description":"...","locator":{...},"check":"toBeVisible|toHaveText|toContainText|toHaveCount|toBeChecked|changesAfterAction","value":"...","captureBeforeAction":0}
Locator forms: {"by":"role","role":"button","name":"Save"} | {"by":"testId","value":"balance"} | {"by":"placeholder","value":"..."} | {"by":"text","value":"Page 10 of 10"} | {"by":"css","value":"tbody tr"}
Optional on any locator: "nth": index, "within": {"locator":{...},"hasText":"row text"} to scope inside the first matching container.
Checks: toBeVisible (value unused), toHaveText/toContainText (string value), toHaveCount (number value), toBeChecked,
changesAfterAction: the element's text must change; we capture its text right before recorded action #captureBeforeAction and expect it to differ at the end.
Data may be randomly generated on every run: never hard-code numbers that depend on data; prefer changesAfterAction for values that should update.
Prefer locators that appear in the accessibility tree or recorded actions.`;

export async function proposeExpectedAssertion(
  page: Page,
  repro: Repro,
  actions: SpecAction[],
  feedback: string[],
): Promise<ExpectedAssertion> {
  const aria = (await page.locator('body').ariaSnapshot()).slice(0, 6000);
  const response = (await metaClient().responses.create({
    model: models.video,
    input: [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: PROMPT },
          { type: 'input_text', text: `Bug report: expected "${repro.expected}", actual "${repro.actual}".` },
          { type: 'input_text', text: `Recorded actions (index: action):\n${actions.map((a, i) => `${i}: ${JSON.stringify(a)}`).join('\n')}` },
          { type: 'input_text', text: `Accessibility tree now (truncated):\n${aria}` },
          ...(feedback.length ? [{ type: 'input_text', text: `Previous attempts were rejected:\n- ${feedback.join('\n- ')}` }] : []),
          { type: 'input_image', image_url: await screenshotDataUrl(page) },
        ],
      },
    ],
  } as never)) as unknown as { output_text: string };
  return AssertionSchema.parse(parseModelJson(response.output_text));
}
