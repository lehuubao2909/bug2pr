/**
 * LLM judge for repro-step extraction: compares predicted steps and diagnosis
 * against the bug's ground truth. Targets are matched semantically (an icon
 * described as "double chevron right" matches "Go to last page"), which a
 * string metric cannot do. The judge never sees the video, only the two JSONs.
 */
import { z } from 'zod';
import { metaClient, models } from '../lib/meta-model-client.js';
import { parseModelJson, type Repro } from '../pipeline/repro-steps-schema.js';

export type Truth = {
  id: string;
  steps: { action: string; target: string; value?: string }[];
  expected: string;
  actual: string;
};

export const VerdictSchema = z.object({
  stepsMatched: z.number().int().min(0),
  stepsTotal: z.number().int().min(0),
  extraSteps: z.number().int().min(0),
  diagnosisCorrect: z.boolean(),
  notes: z.string(),
});
export type Verdict = z.infer<typeof VerdictSchema>;

const PROMPT = `You grade a bug-report extractor. Compare PREDICTED to TRUTH and return ONLY JSON:
{"stepsMatched":int,"stepsTotal":int,"extraSteps":int,"diagnosisCorrect":bool,"notes":"one sentence"}
- stepsTotal = number of TRUTH steps. A TRUTH step is matched if PREDICTED has a step with the same action on the same UI element
  (semantic match: icon descriptions, synonyms and paraphrases count; typed values must match). Order must be consistent.
- extraSteps = PREDICTED click/type/keypress steps that match no TRUTH step (ignore waits, ignore a leading navigation to the current page).
- diagnosisCorrect = PREDICTED expected/actual describe the same wrong behaviour as TRUTH (not just "something looks broken").`;

export async function judgeExtraction(truth: Truth, predicted: Repro): Promise<Verdict> {
  const response = (await metaClient().responses.create({
    model: models.video,
    input: [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: PROMPT },
          { type: 'input_text', text: `TRUTH:\n${JSON.stringify({ steps: truth.steps, expected: truth.expected, actual: truth.actual })}` },
          { type: 'input_text', text: `PREDICTED:\n${JSON.stringify(predicted)}` },
        ],
      },
    ],
  } as never)) as unknown as { output_text: string };
  return VerdictSchema.parse(parseModelJson(response.output_text));
}
