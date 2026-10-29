/**
 * Tracks the mouse cursor through a screen recording with SAM 3.1.
 * Returns one box per frame for the object SAM tracked longest (the cursor),
 * in source-video pixels. Used to ground "where did the user click".
 */
import { parseVideoStream, recordsOfKind } from '@meta-sam/parser';
import { metaClient, models } from '../lib/meta-model-client.js';
import { normalizeSamEvents } from '../lib/normalize-sam-response-stream.js';

export type CursorSample = { frame: number; left: number; top: number; right: number; bottom: number };

// Measured on our eval videos: "cursor" tracked 314-356/356 frames, while
// "mouse cursor" found nothing on one video and missed the first 1.8s of another.
const CURSOR_CONCEPTS = ['cursor', 'mouse cursor', 'black arrow'];

/**
 * Tries concept prompts in order and returns the first track that covers at
 * least minCoverage of the video's frames (or the longest one found).
 */
export async function trackCursorBest(fileId: string, totalFrames: number, minCoverage = 0.6): Promise<CursorSample[]> {
  let best: CursorSample[] = [];
  for (const concept of CURSOR_CONCEPTS) {
    const track = await trackCursor(fileId, concept);
    if (track.length > best.length) best = track;
    if (best.length >= totalFrames * minCoverage) break;
  }
  return best;
}

export async function trackCursor(fileId: string, concept = 'cursor'): Promise<CursorSample[]> {
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
    // drain progressive snapshots; only the final result is used
  }
  const result = await parsed.finalResult;
  if (result.outcome.status !== 'completed') {
    throw new Error(`SAM cursor tracking incomplete: ${result.outcome.status}`);
  }

  // Group boxes by object and keep the longest-lived track.
  const byObject = new Map<string, CursorSample[]>();
  for (const box of recordsOfKind(result.records, 'box')) {
    if (box.frame == null) continue;
    const list = byObject.get(box.objectId) ?? [];
    list.push({ frame: box.frame.frameIndex, left: box.left, top: box.top, right: box.right, bottom: box.bottom });
    byObject.set(box.objectId, list);
  }
  const longest = [...byObject.values()].sort((a, b) => b.length - a.length)[0] ?? [];
  return longest.sort((a, b) => a.frame - b.frame);
}
