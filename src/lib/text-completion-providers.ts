/**
 * Text-only completions for the code-reasoning steps (bug localization and
 * the fix loop), routable to either:
 * - "meta":    Meta Model API (Responses API, Muse Wonder / Muse Spark), or
 * - "baseten": Meta's open-weight Muse Spark Open served by Baseten
 *              (OpenAI-compatible Chat Completions).
 * "Private mode" = route these steps to open weights, so repository source
 * code is only sent to a model you can host yourself.
 *
 * Env: FIX_PROVIDER, LOCALIZE_PROVIDER (meta|baseten), BASETEN_MODEL.
 */
import 'dotenv/config';
import OpenAI from 'openai';
import { metaClient, models } from './meta-model-client.js';

export type Provider = 'meta' | 'baseten';
export type TextRole = 'fix' | 'localize';
export type Completion = { text: string; provider: Provider; model: string; ms: number; usage: unknown };

const BASETEN_URL = 'https://inference.baseten.co/v1';
const BASETEN_MODEL = process.env.BASETEN_MODEL || 'meta-models/muse-spark-open-1026';

let baseten: OpenAI | undefined;
function basetenClient(): OpenAI {
  if (baseten) return baseten;
  if (!process.env.BASETEN_API_KEY) throw new Error('BASETEN_API_KEY is not set in .env');
  baseten = new OpenAI({ apiKey: process.env.BASETEN_API_KEY, baseURL: BASETEN_URL, maxRetries: 4, timeout: 300_000 });
  return baseten;
}

export function providerFor(role: TextRole): { provider: Provider; model: string } {
  const env = role === 'fix' ? process.env.FIX_PROVIDER : process.env.LOCALIZE_PROVIDER;
  const provider: Provider = env === 'baseten' ? 'baseten' : 'meta';
  if (provider === 'baseten') return { provider, model: BASETEN_MODEL };
  return { provider, model: role === 'fix' ? models.fix : models.video };
}

export async function completeText(role: TextRole, parts: string[]): Promise<Completion> {
  const { provider, model } = providerFor(role);
  const started = performance.now();
  if (provider === 'meta') {
    const r = (await metaClient().responses.create({
      model,
      input: [{ role: 'user', content: parts.map((text) => ({ type: 'input_text', text })) }],
    } as never)) as unknown as { output_text: string; usage?: unknown };
    return { text: r.output_text, provider, model, ms: Math.round(performance.now() - started), usage: r.usage };
  }
  const r = await basetenClient().chat.completions.create({
    model,
    messages: [{ role: 'user', content: parts.map((text) => ({ type: 'text' as const, text })) }],
    max_tokens: 32_000,
    reasoning_effort: 'high',
  } as never);
  const completion = r as unknown as { choices: { message: { content: string | null } }[]; usage?: unknown };
  return { text: completion.choices[0]?.message.content ?? '', provider, model, ms: Math.round(performance.now() - started), usage: completion.usage };
}
