/**
 * Video -> structured repro steps with Muse Spark.
 *
 * mode "video": the model only sees the recording.
 * mode "grounded": SAM 3.1 tracks the cursor, we detect where the user
 * interacted (cursor dwell + screen change) and add zoomed before/after crops
 * of each spot, so icon-only buttons and small edits are not guessed.
 */
import { metaClient, models } from '../lib/meta-model-client.js';
import { uploadVideo } from '../lib/upload-video-to-meta-files-api.js';
import { cropAround, pngDataUrl, pngFrame, probeVideo, timestamp } from '../lib/video-frames.js';
import { detectInteractions, type Interaction } from './detect-interactions-from-cursor-track.js';
import { parseModelJson, ReproSchema, type Repro } from './repro-steps-schema.js';
import { trackCursorBest, type CursorSample } from './track-cursor-with-sam.js';

export type ExtractMode = 'video' | 'grounded';

export type ExtractResult = {
  repro: Repro;
  interactions: Interaction[];
  cursorFrames: number;
  ms: { upload: number; sam: number; model: number };
  usage: unknown;
};

const BASE_PROMPT = `You are watching a screen recording of a bug in a web app.
Return ONLY a JSON object (no markdown):
{"steps":[{"t":"mm:ss","action":"click|type|keypress|navigate|scroll|wait","target":"visible text, aria label, or icon description","value":"typed text or key","interaction":0}],
 "expected":"what should have happened","actual":"what actually happened","confidence":0.0-1.0}
Rules: list only actions you can see; use on-screen text for targets; for icon-only buttons describe the icon and its likely purpose (e.g. "double chevron right (go to last page)"); describe the wrong result precisely, quoting on-screen values.`;

const GROUNDED_RULES = `
Cursor evidence: SAM 3.1 tracked the mouse cursor, and the user rested the cursor and the screen changed at the interactions below.
Each has a zoomed crop around the cursor BEFORE and AFTER. Every click/type step must cite its "interaction" index.
Do not invent clicks that have no interaction. One interaction can hold several steps:
- if text appears in a field, emit a click on that field AND a type step, both citing the interaction;
- if an inline edit box closes or focus moves after typing, emit the key press that committed it (usually Tab or Enter).
For icon-only targets (e.g. "..."), name the icon and its purpose, such as "three-dots menu button (account menu)".`;

type InputPart = { type: 'input_text'; text: string } | { type: 'input_image'; image_url: string } | { type: 'input_file'; file_id: string };

/** Text + before/after crops for each detected interaction. */
function evidenceParts(file: string, interactions: Interaction[]): InputPart[] {
  const info = probeVideo(file);
  const lastT = Math.max(info.duration - 0.05, 0);
  return interactions.flatMap((it, i) => {
    const crop = cropAround(info, it.x, it.y);
    return [
      { type: 'input_text' as const, text: `Interaction ${i}: cursor rests at (${Math.round(it.x)}, ${Math.round(it.y)}) from ${timestamp(it.start)} to ${timestamp(it.end)}. Before / after crops:` },
      { type: 'input_image' as const, image_url: pngDataUrl(pngFrame(file, Math.min(it.start + 0.05, lastT), crop, 1.5)) },
      { type: 'input_image' as const, image_url: pngDataUrl(pngFrame(file, Math.min(it.end + 0.3, lastT), crop, 1.5)) },
    ];
  });
}

export async function extractReproSteps(
  file: string,
  mode: ExtractMode,
  opts: { cachedTrack?: CursorSample[] } = {},
): Promise<ExtractResult & { track: CursorSample[] }> {
  const info = probeVideo(file);
  const t0 = performance.now();
  const fileId = await uploadVideo(file);
  const t1 = performance.now();

  let track: CursorSample[] = [];
  let interactions: Interaction[] = [];
  if (mode === 'grounded') {
    track = opts.cachedTrack ?? (await trackCursorBest(fileId, Math.round(info.duration * info.fps)));
    interactions = detectInteractions(file, info, track);
  }
  const t2 = performance.now();

  const content: InputPart[] = [
    { type: 'input_text', text: mode === 'grounded' ? BASE_PROMPT + GROUNDED_RULES : BASE_PROMPT },
    { type: 'input_file', file_id: fileId },
    ...(mode === 'grounded' ? evidenceParts(file, interactions) : []),
  ];
  const response = (await metaClient().responses.create({
    model: models.video,
    input: [{ role: 'user', content }],
  } as never)) as unknown as { output_text: string; usage?: unknown };
  const t3 = performance.now();

  const repro = ReproSchema.parse(parseModelJson(response.output_text));
  return {
    repro,
    interactions,
    track,
    cursorFrames: track.length,
    ms: { upload: Math.round(t1 - t0), sam: Math.round(t2 - t1), model: Math.round(t3 - t2) },
    usage: response.usage,
  };
}
