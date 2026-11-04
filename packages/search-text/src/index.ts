export const TEXT_LIMITS = Object.freeze({ bytes: 512, depth: 4, leaves: 64, phraseTokens: 32 });

export type TextNode =
  | { kind: 'term' | 'phrase'; value: string }
  | { kind: 'not'; child: TextNode }
  | { kind: 'and' | 'or'; children: TextNode[] };

export const TEXT_DIAGNOSTIC_REASONS = [
  'expected_operand',
  'unexpected_close',
  'unclosed_group',
  'unclosed_phrase',
  'unsupported_escape',
  'empty_phrase',
  'negated_operand',
  'byte_limit',
  'depth_limit',
  'leaf_limit',
  'phrase_token_limit',
] as const;
export type TextDiagnosticReason = (typeof TEXT_DIAGNOSTIC_REASONS)[number];

/** Offsets are zero-based UTF-16 boundaries, suitable for textarea selection.
 * Code-point positions and the UTF-8 byte offset are reported separately, never conflated.
 * The parser stops at 512 UTF-8 bytes; the end can include one offending code point.
 */
export type TextDiagnostic = {
  reason: TextDiagnosticReason;
  unit: 'utf16';
  start: number;
  end: number;
  codePointStart: number;
  codePointEnd: number;
  byteOffset: number;
};

export class TextSyntaxError extends Error {
  constructor(
    public readonly code: 'unsupported' | 'out_of_range',
    public readonly offset: number,
    public readonly diagnostic: TextDiagnostic,
  ) {
    super(`${code} text query at offset ${offset}`);
    this.name = 'TextSyntaxError';
  }
}

const whitespace = /\p{White_Space}/u;
const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const letterOrDigit = /[\p{L}\p{N}]/u;
const escapes = new Set(['\\', '"', '|', '(', ')', '-']);

function combine(kind: 'and' | 'or', children: TextNode[]): TextNode {
  const flattened: TextNode[] = [];
  for (const child of children) {
    if (child.kind === kind) flattened.push(...child.children);
    else flattened.push(child);
  }
  return flattened.length === 1 ? flattened[0]! : { kind, children: flattened };
}

class Parser {
  private offset = 0;
  private bytes = 0;
  private leaves = 0;

  constructor(private readonly input: string) {}

  private fail(reason: TextDiagnosticReason, start = this.offset, end?: number): never {
    const point = this.input.codePointAt(start);
    const boundary = end ?? start + (point === undefined ? 0 : point > 0xffff ? 2 : 1);
    const before = this.input.slice(0, start);
    const codePointStart = [...before].length;
    const code = reason.endsWith('_limit') ? 'out_of_range' : 'unsupported';
    throw new TextSyntaxError(code, start, {
      reason,
      unit: 'utf16',
      start,
      end: boundary,
      codePointStart,
      codePointEnd: codePointStart + [...this.input.slice(start, boundary)].length,
      byteOffset: new TextEncoder().encode(before).length,
    });
  }

  private peek(): string {
    const point = this.input.codePointAt(this.offset);
    return point === undefined ? '' : String.fromCodePoint(point);
  }

  private take(): string {
    const character = this.peek();
    const point = character.codePointAt(0)!;
    const width = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (this.bytes + width > TEXT_LIMITS.bytes) this.fail('byte_limit');
    this.bytes += width;
    this.offset += character.length;
    return character;
  }

  private skipWhitespace(): void {
    while (whitespace.test(this.peek())) this.take();
  }

  private escaped(): string {
    const start = this.offset;
    this.take();
    if (!escapes.has(this.peek())) this.fail('unsupported_escape', start, this.offset + this.peek().length);
    return this.take();
  }

  parse(): TextNode {
    const node = this.disjunction(0);
    if (this.peek()) this.fail('unexpected_close');
    return node;
  }

  private disjunction(depth: number): TextNode {
    const children = [this.conjunction(depth)];
    while (this.peek() === '|') {
      this.take();
      children.push(this.conjunction(depth));
    }
    return combine('or', children);
  }

  private conjunction(depth: number): TextNode {
    const children: TextNode[] = [];
    this.skipWhitespace();
    while (this.peek() && this.peek() !== '|' && this.peek() !== ')') {
      children.push(this.operand(depth));
      this.skipWhitespace();
    }
    if (!children.length) this.fail('expected_operand');
    return combine('and', children);
  }

  private operand(depth: number): TextNode {
    if (this.peek() !== '-') return this.primary(depth);
    const start = this.offset;
    this.take();
    const next = this.peek();
    if (!next || whitespace.test(next) || next === '-' || next === '|' || next === ')')
      this.fail('negated_operand', start);
    return { kind: 'not', child: this.primary(depth) };
  }

  private primary(depth: number): TextNode {
    if (this.peek() !== '(') return this.leaf();
    const start = this.offset;
    if (depth === TEXT_LIMITS.depth) this.fail('depth_limit', start);
    this.take();
    this.skipWhitespace();
    if (!this.peek() || this.peek() === ')') this.fail('expected_operand', start);
    const node = this.disjunction(depth + 1);
    if (this.peek() !== ')') this.fail('unclosed_group', start);
    this.take();
    return node;
  }

  private leaf(): TextNode {
    const start = this.offset;
    const phrase = this.peek() === '"';
    if (phrase) this.take();
    let value = '';
    let tokens = 0;
    let inRun = false;
    while (this.peek()) {
      const next = this.peek();
      if (next === '"' || (!phrase && (whitespace.test(next) || next === '|' || next === '(' || next === ')'))) break;
      const position = this.offset;
      const character = next === '\\' ? this.escaped() : this.take();
      value += character;
      if (phrase) {
        const single = cjk.test(character);
        const run = !single && letterOrDigit.test(character);
        if (single || (run && !inRun)) tokens++;
        inRun = run;
        if (tokens > TEXT_LIMITS.phraseTokens) this.fail('phrase_token_limit', position);
      }
    }
    if (phrase) {
      if (this.peek() !== '"') this.fail('unclosed_phrase', start);
      this.take();
    }
    if (!value) this.fail('empty_phrase', start);
    if (++this.leaves > TEXT_LIMITS.leaves) this.fail('leaf_limit', start);
    return { kind: phrase ? 'phrase' : 'term', value };
  }
}

// The cursor consumes each code point once, charging UTF-8 bytes before advancing.
// Only groups recurse into the grammar, and their depth is checked before entry.
export function parseText(input: string): TextNode {
  return new Parser(input).parse();
}

export function positiveText(node: TextNode): boolean {
  switch (node.kind) {
    case 'term':
    case 'phrase':
      return true;
    case 'not':
      return false;
    case 'and':
      return node.children.some(positiveText);
    case 'or':
      return node.children.every(positiveText);
  }
}

/** The same parser supplies local deliberate-submit feedback and native admission. */
export function diagnoseText(input: string): TextDiagnostic | undefined {
  try {
    parseText(input);
  } catch (error) {
    if (error instanceof TextSyntaxError) return error.diagnostic;
    throw error;
  }
}

/** Admit only the closed bounded wire diagnostic, copying no arbitrary response fields. */
export function readTextDiagnostic(value: unknown): TextDiagnostic | undefined {
  if (!value || typeof value !== 'object') return;
  const d = value as Record<string, unknown>;
  if (!TEXT_DIAGNOSTIC_REASONS.includes(d.reason as TextDiagnosticReason) || d.unit !== 'utf16') return;
  const { start, end, codePointStart, codePointEnd, byteOffset } = d;
  const bounded = (n: unknown, maximum: number): n is number =>
    typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= maximum;
  if (
    !bounded(start, 512) ||
    !bounded(end, 514) ||
    end < start ||
    end - start > 3 ||
    !bounded(codePointStart, 512) ||
    !bounded(codePointEnd, 513) ||
    codePointEnd < codePointStart ||
    codePointEnd - codePointStart > 2 ||
    !bounded(byteOffset, 512)
  )
    return;
  return {
    reason: d.reason as TextDiagnosticReason,
    unit: 'utf16',
    start,
    end,
    codePointStart,
    codePointEnd,
    byteOffset,
  };
}
