/**
 * Smoke test 1/3: can Muse Spark watch a bug screen recording and return
 * structured repro steps? Uploads the video, asks for JSON, validates it with
 * zod and records latency + token usage.
 *
 * Usage: npm run smoke:video [-- path/to/video.mp4]
 */
import { z } from 'zod';
import { metaClient, models } from '../../src/lib/meta-model-client.js';
import { uploadVideo } from '../../src/lib/upload-video-to-meta-files-api.js';
import { runDir, timed, writeJson } from '../../src/lib/write-run-artifact.js';

const VIDEO = process.argv[2] ?? 'fixtures/videos/todo-counter-bug.mp4';

const ReproSchema = z.object({
  steps: z.array(
    z.object({
      t: z.string().describe('timestamp mm:ss in the video'),
      action: z.enum(['navigate', 'click', 'type', 'scroll', 'wait']),
      target: z.string().describe('visible text or label of the element'),
      value: z.string().optional(),
    }),
  ),
  expected: z.string(),
  actual: z.string(),
  confidence: z.number().min(0).max(1),
});

const PROMPT = `You are watching a screen recording of a web app bug.
Return ONLY a JSON object (no markdown) with this shape:
{"steps":[{"t":"mm:ss","action":"click|type|navigate|scroll|wait","target":"visible text or aria label","value":"typed text if any"}],
 "expected":"what should have happened","actual":"what actually happened","confidence":0.0-1.0}
Use visible on-screen text for targets. Do not guess steps you cannot see.`;

/** Strips optional ```json fences before parsing. */
function parseJson(text: string): unknown {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '');
  return JSON.parse(cleaned);
}

async function main(): Promise<void> {
  const dir = await runDir('smoke-video');
  const upload = await timed(() => uploadVideo(VIDEO));
  console.log(`Uploaded ${VIDEO} as ${upload.result} (${upload.ms} ms)`);

  const call = await timed(() =>
    metaClient().responses.create({
      model: models.video,
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: PROMPT },
            { type: 'input_file', file_id: upload.result },
          ],
        },
      ],
    } as never),
  );
  const response = call.result as unknown as { output_text: string; usage?: unknown };
  console.log(`${models.video} answered in ${call.ms} ms`);

  let parsed: z.infer<typeof ReproSchema> | undefined;
  let error: string | undefined;
  try {
    parsed = ReproSchema.parse(parseJson(response.output_text));
  } catch (err) {
    error = String(err);
  }

  const file = await writeJson(dir, 'result.json', {
    model: models.video,
    video: VIDEO,
    uploadMs: upload.ms,
    responseMs: call.ms,
    usage: response.usage,
    raw: response.output_text,
    parsed,
    error,
  });
  console.log(parsed ? JSON.stringify(parsed, null, 2) : `Schema/parse error: ${error}\nRaw:\n${response.output_text}`);
  console.log(`Saved ${file}`);
  if (!parsed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
