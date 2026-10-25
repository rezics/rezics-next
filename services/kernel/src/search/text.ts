export const TEXT_LIMITS = Object.freeze({ bytes: 512, depth: 4, leaves: 64, phraseTokens: 32 });

export type TextNode =
  | { kind: 'term' | 'phrase'; value: string }
  | { kind: 'not'; child: TextNode }
  | { kind: 'and' | 'or'; children: TextNode[] };

export class TextSyntaxError extends Error {
  constructor(
    public readonly code: 'unsupported' | 'out_of_range',
    public readonly offset: number,
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

  private peek(): string {
    const point = this.input.codePointAt(this.offset);
    return point === undefined ? '' : String.fromCodePoint(point);
  }

  private take(): string {
    const character = this.peek();
    const point = character.codePointAt(0)!;
    const width = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (this.bytes + width > TEXT_LIMITS.bytes) throw new TextSyntaxError('out_of_range', this.offset);
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
    if (!escapes.has(this.peek())) throw new TextSyntaxError('unsupported', start);
    return this.take();
  }

  parse(): TextNode {
    const node = this.disjunction(0);
    if (this.peek()) throw new TextSyntaxError('unsupported', this.offset);
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
    if (!children.length) throw new TextSyntaxError('unsupported', this.offset);
    return combine('and', children);
  }

  private operand(depth: number): TextNode {
    if (this.peek() !== '-') return this.primary(depth);
    const start = this.offset;
    this.take();
    const next = this.peek();
    if (!next || whitespace.test(next) || next === '-' || next === '|' || next === ')')
      throw new TextSyntaxError('unsupported', start);
    return { kind: 'not', child: this.primary(depth) };
  }

  private primary(depth: number): TextNode {
    if (this.peek() !== '(') return this.leaf();
    const start = this.offset;
    if (depth === TEXT_LIMITS.depth) throw new TextSyntaxError('out_of_range', start);
    this.take();
    this.skipWhitespace();
    if (!this.peek() || this.peek() === ')') throw new TextSyntaxError('unsupported', start);
    const node = this.disjunction(depth + 1);
    if (this.peek() !== ')') throw new TextSyntaxError('unsupported', start);
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
        if (tokens > TEXT_LIMITS.phraseTokens) throw new TextSyntaxError('out_of_range', position);
      }
    }
    if (phrase) {
      if (this.peek() !== '"') throw new TextSyntaxError('unsupported', start);
      this.take();
    }
    if (!value) throw new TextSyntaxError('unsupported', start);
    if (++this.leaves > TEXT_LIMITS.leaves) throw new TextSyntaxError('out_of_range', start);
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

type TextQuery =
  | { match: Record<string, { query: string; operator: 'and'; _name: string }> }
  | { match_phrase: Record<string, { query: string; _name: string }> }
  | { bool: { must?: TextQuery[]; must_not?: TextQuery[]; should?: TextQuery[]; minimum_should_match?: 1 } };

type TextLeaf = { name: string; kind: 'term' | 'phrase'; value: string; negated: boolean };

export function compileText(
  node: TextNode,
  { field, prefix }: { field: string; prefix: string },
): { query: TextQuery; leaves: TextLeaf[] } {
  const leaves: TextLeaf[] = [];
  function compile(current: TextNode, negated: boolean): TextQuery {
    switch (current.kind) {
      case 'term':
      case 'phrase': {
        const name = `${prefix}${leaves.length}`;
        const { kind, value } = current;
        leaves.push({ name, kind, value, negated });
        return kind === 'term'
          ? { match: { [field]: { query: value, operator: 'and', _name: name } } }
          : { match_phrase: { [field]: { query: value, _name: name } } };
      }
      case 'not':
        return { bool: { must_not: [compile(current.child, !negated)] } };
      case 'and': {
        const must: TextQuery[] = [];
        const must_not: TextQuery[] = [];
        for (const child of current.children) {
          if (child.kind === 'not') must_not.push(compile(child.child, !negated));
          else must.push(compile(child, negated));
        }
        return { bool: { ...(must.length ? { must } : {}), ...(must_not.length ? { must_not } : {}) } };
      }
      case 'or':
        return { bool: { should: current.children.map((child) => compile(child, negated)), minimum_should_match: 1 } };
    }
  }
  return { query: compile(node, false), leaves };
}
