/**
 * Shape of the repro steps the extractor returns, plus a tolerant JSON parser
 * for model output (strips ```json fences).
 */
import { z } from 'zod';

export const ReproStepSchema = z.object({
  t: z.string().describe('timestamp mm:ss in the video'),
  action: z.enum(['navigate', 'click', 'type', 'keypress', 'scroll', 'wait']),
  target: z.string().describe('visible text, aria label or icon description of the element'),
  value: z.string().optional(),
  interaction: z.number().int().optional().describe('index of the cursor interaction this step is grounded in'),
});

export const ReproSchema = z.object({
  steps: z.array(ReproStepSchema),
  expected: z.string(),
  actual: z.string(),
  confidence: z.number().min(0).max(1),
});

export type Repro = z.infer<typeof ReproSchema>;

export function parseModelJson(text: string): unknown {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  return JSON.parse(cleaned);
}
