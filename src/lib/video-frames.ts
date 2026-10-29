/**
 * ffmpeg/ffprobe helpers for reading single frames out of a video:
 * metadata, a small grayscale frame for pixel diffs, and a PNG crop for
 * showing the model what is under the cursor.
 */
import { execFileSync } from 'node:child_process';

export type VideoInfo = { width: number; height: number; fps: number; duration: number };

export function probeVideo(file: string): VideoInfo {
  const out = execFileSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,r_frame_rate:format=duration',
    '-of', 'json', file,
  ]).toString();
  const json = JSON.parse(out) as { streams: { width: number; height: number; r_frame_rate: string }[]; format: { duration: string } };
  const stream = json.streams[0];
  if (!stream) throw new Error(`No video stream in ${file}`);
  const [num, den] = stream.r_frame_rate.split('/').map(Number);
  return { width: stream.width, height: stream.height, fps: num! / (den || 1), duration: Number(json.format.duration) };
}

/** Grayscale frame at time t, downscaled to w×h, as raw bytes (one per pixel). */
export function grayFrame(file: string, t: number, w = 320, h = 200): Buffer {
  return execFileSync('ffmpeg', [
    '-v', 'error', '-ss', t.toFixed(3), '-i', file, '-frames:v', '1',
    '-vf', `scale=${w}:${h},format=gray`, '-f', 'rawvideo', '-',
  ]);
}

export type Crop = { x: number; y: number; w: number; h: number };

/** PNG of the frame at time t, optionally cropped (source pixels) and upscaled. */
export function pngFrame(file: string, t: number, crop?: Crop, scale = 1): Buffer {
  const filters = [crop && `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`, scale !== 1 && `scale=iw*${scale}:ih*${scale}`].filter(Boolean);
  return execFileSync('ffmpeg', [
    '-v', 'error', '-ss', t.toFixed(3), '-i', file, '-frames:v', '1',
    ...(filters.length ? ['-vf', filters.join(',')] : []),
    '-f', 'image2pipe', '-vcodec', 'png', '-',
  ]);
}

/** Crop box of size w×h centred on (cx, cy), clamped inside the frame. */
export function cropAround(info: VideoInfo, cx: number, cy: number, w = 360, h = 220): Crop {
  const x = Math.round(Math.min(Math.max(cx - w / 2, 0), info.width - w));
  const y = Math.round(Math.min(Math.max(cy - h / 2, 0), info.height - h));
  return { x, y, w, h };
}

export const pngDataUrl = (png: Buffer): string => `data:image/png;base64,${png.toString('base64')}`;

/** Formats seconds as mm:ss.s for prompts and logs. */
export function timestamp(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = (seconds - m * 60).toFixed(1).padStart(4, '0');
  return `${String(m).padStart(2, '0')}:${s}`;
}
