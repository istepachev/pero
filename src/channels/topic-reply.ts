import { topicNameSchema } from '../telegram/topic-input.js';

/** Only standalone directives outside code fences are topic proposals. */
export function topicReply(answer: string): { text: string; names: string[] } {
  const names: string[] = [];
  const kept: string[] = [];
  let fence: string | null = null;
  for (const line of answer.split('\n')) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker !== undefined) {
      if (fence === null) fence = marker[0]!;
      else if (marker[0] === fence) fence = null;
      kept.push(line);
      continue;
    }
    const matched =
      fence === null ? /^<topic>([^\r\n]*)<\/topic>\s*$/.exec(line) : null;
    const parsed =
      matched === null ? null : topicNameSchema.safeParse(matched[1]);
    if (parsed?.success && names.length < 3) {
      if (!names.includes(parsed.data)) names.push(parsed.data);
    } else kept.push(line);
  }
  return { text: kept.join('\n').trim(), names };
}
