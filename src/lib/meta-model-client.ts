/**
 * Shared Meta Model API client. The API is OpenAI-compatible, so we use the
 * official OpenAI SDK pointed at api.meta.ai. The key is read from the
 * environment (.env) and never logged.
 */
import 'dotenv/config';
import OpenAI from 'openai';

const DEFAULT_BASE_URL = 'https://api.meta.ai/v1';

export const models = {
  video: process.env.META_VIDEO_MODEL || 'muse-spark-1.3',
  computerUse: process.env.META_COMPUTER_USE_MODEL || 'muse-spark-1.3',
  sam: process.env.META_SAM_MODEL || 'sam-3.1',
} as const;

let cached: OpenAI | undefined;

/** Lazily builds one client; throws a clear error when the key is missing. */
export function metaClient(): OpenAI {
  if (cached) return cached;
  const apiKey = process.env.META_API_KEY;
  if (!apiKey) {
    throw new Error('META_API_KEY is not set: copy .env.example to .env and add your key.');
  }
  cached = new OpenAI({
    apiKey,
    baseURL: process.env.META_API_BASE_URL || DEFAULT_BASE_URL,
    maxRetries: 4, // SDK retries 429/503 with the server's backoff
    timeout: 300_000, // video and computer-use turns can be slow
  });
  return cached;
}
