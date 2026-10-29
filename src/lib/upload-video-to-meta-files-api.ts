/**
 * Uploads a local video to the Meta Files API (purpose "user_data") so it can
 * be referenced by file_id from Muse Spark (video understanding) and SAM 3.1.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { toFile } from 'openai';
import { metaClient } from './meta-model-client.js';

const VIDEO_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
};

export async function uploadVideo(filename: string): Promise<string> {
  const type = VIDEO_TYPES[path.extname(filename).toLowerCase()];
  if (!type) throw new Error(`Unsupported video type for ${filename} (use .mp4 or .mov)`);

  const bytes = await readFile(filename);
  const uploaded = await metaClient().files.create({
    file: await toFile(bytes, path.basename(filename), { type }),
    purpose: 'user_data',
  });
  if (typeof uploaded.id !== 'string' || !uploaded.id.startsWith('file-')) {
    throw new Error(`Files API returned an unexpected id: ${String(uploaded.id)}`);
  }
  return uploaded.id;
}
