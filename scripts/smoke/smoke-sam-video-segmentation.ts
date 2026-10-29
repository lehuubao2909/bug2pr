/**
 * Smoke test 3/3: can SAM 3.1 track UI things in a screen recording?
 * Tries a few concept prompts (cursor, checkbox, button) on the fixture video
 * and reports how many frames each object is tracked in. Decides whether SAM
 * stays in the pipeline or becomes a demo-only overlay.
 *
 * Usage: npm run smoke:sam [-- path/to/video.mp4]
 */
import { parseVideoStream, recordsOfKind } from '@meta-sam/parser';
import { metaClient, models } from '../../src/lib/meta-model-client.js';
import { normalizeSamEvents } from '../../src/lib/normalize-sam-response-stream.js';
import { uploadVideo } from '../../src/lib/upload-video-to-meta-files-api.js';
import { runDir, timed, writeJson } from '../../src/lib/write-run-artifact.js';

const VIDEO = process.argv[2] ?? 'fixtures/videos/todo-counter-bug.mp4';
const CONCEPTS = ['mouse cursor', 'checkbox', 'button'];

async function segment(fileId: string, concept: string) {
  const stream = await metaClient().responses.create({
    model: models.sam,
    stream: true,
    input: [
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: concept },
          { type: 'input_video', file_id: fileId },
        ],
      },
    ],
  } as never);
  const parsed = parseVideoStream(normalizeSamEvents(stream as unknown as AsyncIterable<unknown>));
  for await (const _snapshot of parsed) {
    // drain the stream; the final result is collected below
  }
  return parsed.finalResult;
}

async function main(): Promise<void> {
  const dir = await runDir('smoke-sam');
  const fileId = await uploadVideo(VIDEO);
  console.log(`Uploaded ${VIDEO} as ${fileId}`);

  const summaries = [];
  for (const concept of CONCEPTS) {
    try {
      const { result, ms } = await timed(() => segment(fileId, concept));
      const boxes = recordsOfKind(result.records, 'box');
      const framesPerObject = new Map<string, Set<number>>();
      for (const box of boxes) {
        if (box.frame == null) continue;
        const set = framesPerObject.get(box.objectId) ?? new Set<number>();
        set.add(box.frame.frameIndex);
        framesPerObject.set(box.objectId, set);
      }
      const summary = {
        concept,
        ms,
        outcome: result.outcome.status,
        objects: framesPerObject.size,
        framesPerObject: Object.fromEntries([...framesPerObject].map(([id, f]) => [id, f.size])),
        sampleBoxes: boxes.slice(0, 3).map((b) => ({ obj: b.objectId, frame: b.frame?.frameIndex, l: b.left, t: b.top, r: b.right, b: b.bottom })),
        errors: result.diagnostics.filter((d) => d.severity === 'error').length,
      };
      summaries.push(summary);
      console.log(`${concept}: ${summary.outcome}, ${summary.objects} object(s), ${ms} ms`);
    } catch (err) {
      summaries.push({ concept, error: String(err) });
      console.log(`${concept}: ERROR ${String(err)}`);
    }
  }
  const file = await writeJson(dir, 'result.json', { model: models.sam, video: VIDEO, fileId, summaries });
  console.log(`Saved ${file}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
