/**
 * Adapter between the OpenAI SDK stream and @meta-sam/parser.
 * The API emits `response.content_part.done` but not always
 * `response.output_text.done`, which the parser needs to finalize a lane, so
 * we synthesize it. Adapted from meta-models/meta-model-cookbook
 * (07_sam/01_api_basics, MIT License, Copyright (c) Meta Platforms, Inc.).
 */
import type { ResponsesEvent } from '@meta-sam/parser';

type RawEvent = {
  type?: string;
  item_id?: unknown;
  output_index?: unknown;
  content_index?: unknown;
  part?: { type?: unknown; text?: unknown } | null;
};

export async function* normalizeSamEvents(stream: AsyncIterable<unknown>): AsyncIterable<ResponsesEvent> {
  const completed = new Set<string>();
  for await (const raw of stream) {
    const event = raw as RawEvent;
    const lane = `${String(event.item_id)}:${String(event.output_index)}:${String(event.content_index)}`;
    if (event.type === 'response.output_text.done') {
      if (!completed.has(lane)) {
        completed.add(lane);
        yield event as unknown as ResponsesEvent;
      }
      continue;
    }
    yield event as unknown as ResponsesEvent;
    const part = event.part;
    if (event.type === 'response.content_part.done' && !completed.has(lane) && part?.type === 'output_text' && typeof part.text === 'string') {
      completed.add(lane);
      yield {
        type: 'response.output_text.done',
        item_id: event.item_id,
        output_index: event.output_index,
        content_index: event.content_index,
        text: part.text,
      } as unknown as ResponsesEvent;
    }
  }
}
