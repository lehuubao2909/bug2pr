/**
 * Turns a SAM cursor track into candidate user interactions.
 * Heuristic: a person clicks (or types) where the cursor rests. We find
 * "dwells" (cursor still for >= MIN_DWELL_S) and keep only those during which
 * the screen actually changed, which filters out idle hovering.
 */
import type { CursorSample } from './track-cursor-with-sam.js';
import { grayFrame, type VideoInfo } from '../lib/video-frames.js';

export type Interaction = {
  start: number; // seconds: cursor arrives
  end: number; // seconds: cursor leaves (or video ends)
  x: number; // cursor hotspot in source pixels
  y: number;
  change: number; // fraction of screen pixels that changed during the dwell
};

const STILL_PX = 4; // max drift to still count as resting
const MIN_DWELL_S = 0.35;
const MAX_GAP_S = 0.25; // tolerate short SAM detection gaps inside a dwell
const DIFF_LEVEL = 25; // grayscale delta that counts as a changed pixel
const MIN_CHANGE = 0.0003; // ~75 pixels at 640x400: enough for a few typed characters

type Dwell = { first: CursorSample; last: CursorSample };

function findDwells(track: CursorSample[], fps: number): Dwell[] {
  const dwells: Dwell[] = [];
  let anchor = track[0];
  let last = track[0];
  const flush = () => {
    if (anchor && last && (last.frame - anchor.frame) / fps >= MIN_DWELL_S) dwells.push({ first: anchor, last });
  };
  for (const s of track.slice(1)) {
    if (!anchor || !last) break;
    const still = Math.abs(s.left - anchor.left) <= STILL_PX && Math.abs(s.top - anchor.top) <= STILL_PX;
    const contiguous = (s.frame - last.frame) / fps <= MAX_GAP_S;
    if (still && contiguous) {
      last = s;
    } else {
      flush();
      anchor = s;
      last = s;
    }
  }
  flush();
  return dwells;
}

/** Fraction of pixels that differ between two frames, ignoring the cursor's own box. */
function screenChange(file: string, info: VideoInfo, t0: number, t1: number, cursor: CursorSample): number {
  const w = 640;
  const h = 400;
  const a = grayFrame(file, t0, w, h);
  const b = grayFrame(file, t1, w, h);
  const sx = w / info.width;
  const sy = h / info.height;
  const pad = 6;
  const mask = {
    x0: Math.floor(cursor.left * sx) - pad, x1: Math.ceil(cursor.right * sx) + pad,
    y0: Math.floor(cursor.top * sy) - pad, y1: Math.ceil(cursor.bottom * sy) + pad,
  };
  let changed = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x >= mask.x0 && x <= mask.x1 && y >= mask.y0 && y <= mask.y1) continue;
      const i = y * w + x;
      if (Math.abs(a[i]! - b[i]!) > DIFF_LEVEL) changed++;
    }
  }
  return changed / (w * h);
}

export function detectInteractions(file: string, info: VideoInfo, track: CursorSample[], minChange = MIN_CHANGE): Interaction[] {
  const last = Math.max(info.duration - 0.05, 0);
  const firstFrame = track[0]?.frame;
  return findDwells(track, info.fps)
    // The cursor parked where the recording started has not been moved by the
    // user yet; screen changes there are page load, not an interaction.
    .filter(({ first }) => first.frame !== firstFrame)
    .map(({ first, last: end }) => {
      const start = first.frame / info.fps;
      const stop = end.frame / info.fps;
      // Compare just before the cursor settles with shortly after it leaves.
      const change = screenChange(file, info, Math.min(start + 0.05, last), Math.min(stop + 0.3, last), first);
      return { start, end: stop, x: first.left + 2, y: first.top + 2, change };
    })
    .filter((i) => i.change >= minChange);
}
