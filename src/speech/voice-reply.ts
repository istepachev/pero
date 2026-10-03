/*
 * An answer's voice messages: an agent asks for one by putting what to say
 * in a `<voice>…</voice>` block. Pure, so the rules are tested without an
 * adapter.
 */

/** A part of an answer: text to send as it is, or words to speak. */
export interface AnswerPart {
  kind: 'text' | 'voice';
  text: string;
}

const VOICE_BLOCK = /<voice>([\s\S]*?)<\/voice>/gi;
/** Fenced code blocks, then inline code: a block there is only shown. */
const CODE = /```[\s\S]*?(?:```|$)|`[^`\n]*`/g;

/**
 * `answer` split into its parts, in order: the text between voice blocks,
 * trimmed, and each block's words. Empty parts are left out. A block
 * inside code isn't one.
 */
export function answerParts(answer: string): AnswerPart[] {
  // Code is blanked out, keeping every index, so blocks in it don't match.
  const masked = answer.replace(CODE, (code) => '\0'.repeat(code.length));
  const parts: AnswerPart[] = [];
  const push = (kind: AnswerPart['kind'], text: string) => {
    const trimmed = kind === 'text' ? tidy(text) : text.trim();
    if (trimmed !== '') parts.push({ kind, text: trimmed });
  };
  let from = 0;
  for (const match of masked.matchAll(VOICE_BLOCK)) {
    const start = match.index;
    const end = start + match[0].length;
    push('text', answer.slice(from, start));
    push(
      'voice',
      answer.slice(start + '<voice>'.length, end - '</voice>'.length),
    );
    from = end;
  }
  push('text', answer.slice(from));
  return parts;
}

/** Whether `answer` asks for a voice message. */
export function hasVoice(answer: string): boolean {
  return answerParts(answer).some((part) => part.kind === 'voice');
}

/** `text` trimmed, with runs of blank lines a removed block left kept to one. */
function tidy(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n').trim();
}
