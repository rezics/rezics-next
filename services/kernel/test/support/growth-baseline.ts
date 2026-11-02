import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { GrowthDatabase, Population } from './growth.ts';
import { seed } from './growth.ts';

export type GrowthBaselineEntry = Readonly<{ name: string; file: string; reason: string }>;

/** Checks retained on the step rule until their series bound is established. This list may only shrink. */
export const GROWTH_BASELINE: readonly GrowthBaselineEntry[] = [
  {
    name: 'account Realm page',
    file: 'services/kernel/test/access/growth-account-realms.test.ts',
    reason: 'B: docs/research/growth-shadow-triage-access.md',
  },
  {
    name: 'actor evaluator G',
    file: 'services/kernel/test/access/growth-evaluator.test.ts',
    reason: 'B: docs/research/growth-shadow-triage-access.md',
  },
  {
    name: 'platform governance reach',
    file: 'services/kernel/test/access/growth-governance-reach.test.ts',
    reason: 'T: docs/research/growth-shadow-triage-access.md',
  },
  {
    name: 'total operator fence fanout',
    file: 'services/kernel/test/access/growth-operator-fencing.test.ts',
    reason: 'B: docs/research/growth-shadow-triage-access.md',
  },
  {
    name: 'organization cleanup step',
    file: 'services/kernel/test/access/growth-organization-close.test.ts',
    reason: 'T: docs/research/growth-shadow-triage-access.md',
  },
  {
    name: 'public identity read',
    file: 'services/kernel/test/access/growth-public-identity-read.test.ts',
    reason: 'B: docs/research/growth-shadow-triage-access.md',
  },
  {
    name: 'Realm-authorized moderation HTTP point command including current Access and same-partition history',
    file: 'services/kernel/test/content/moderation-http.test.ts',
    reason: 'T: docs/research/growth-shadow-triage-content-b.md',
  },
  {
    name: 'bounded neighbourhood probes',
    file: 'services/kernel/test/content/neighbourhood-storage.test.ts',
    reason: 'T: docs/research/growth-shadow-triage-content-b.md',
  },
  {
    name: 'Authenticated content command admission',
    file: 'services/kernel/test/content/point-command-admission.test.ts',
    reason: 'T: docs/research/growth-shadow-triage-content-b.md',
  },
  {
    name: 'post revise precondition and revisedAt read',
    file: 'services/kernel/test/content/post-revise-precondition.test.ts',
    reason: 'T: docs/research/growth-shadow-triage-content-b.md',
  },
  {
    name: 'current board, post, post-page and revision-page disclosure',
    file: 'services/kernel/test/content/read.test.ts',
    reason: 'T: docs/research/growth-shadow-triage-content-b.md',
  },
  {
    name: 'Protected Realm member thread read',
    file: 'services/kernel/test/content/realm-boards.test.ts',
    reason: 'B: docs/research/growth-shadow-triage-content-b.md',
  },
  {
    name: 'content write participation with unrelated Realms, members and bans',
    file: 'services/kernel/test/content/realm-participation.test.ts',
    reason: 'T: docs/research/growth-shadow-triage-content-b.md',
  },
  {
    name: 'report HTTP admission and create',
    file: 'services/kernel/test/content/reports-http.test.ts',
    reason: 'T: docs/research/growth-shadow-triage-content-b.md',
  },
  {
    name: 'Leave a Realm',
    file: 'services/kernel/test/community/growth-join.test.ts',
    reason: 'B: docs/research/growth-shadow-triage-other.md',
  },
  {
    name: 'Realm participation',
    file: 'services/kernel/test/community/participation.test.ts',
    reason: 'B: docs/research/growth-shadow-triage-other.md',
  },
  {
    name: 'New command',
    file: 'services/kernel/test/growth-command.test.ts',
    reason: 'T: docs/research/growth-shadow-triage-other.md',
  },
  {
    name: 'rating subject merge page voters',
    file: 'services/kernel/test/rating/subject-merge.test.ts',
    reason: 'B: docs/research/growth-shadow-triage-other.md',
  },
  {
    name: 'voter Realm membership',
    file: 'services/kernel/test/rating/voter-realms.test.ts',
    reason: 'T: docs/research/growth-shadow-triage-other.md',
  },
  {
    name: 'effects relay discovery',
    file: 'services/kernel/test/relay-effects.test.ts',
    reason: 'B: docs/research/growth-shadow-triage-other.md',
  },
  {
    name: 'A subject read examines the same rows whatever the number of relations it holds',
    file: 'services/kernel/test/semantic/growth-relations.test.ts',
    reason: 'B: docs/research/growth-shadow-triage-other.md',
  },
  {
    name: 'workflow retention batch',
    file: 'services/kernel/test/work/growth-retention.test.ts',
    reason: 'T: docs/research/growth-shadow-triage-other.md',
  },
] as const;

const repositoryRoot = resolve(import.meta.dir, '../../../../');

type Literal = Readonly<{ start: number; end: number; kind: 'string' | 'template' }>;

function maskNonCode(source: string): { code: string; literals: readonly Literal[] } {
  const characters = source.split('');
  const literals: Literal[] = [];
  const blank = (start: number, end: number) => {
    for (let index = start; index < end; index++)
      if (source[index] !== '\n' && source[index] !== '\r') characters[index] = ' ';
  };
  const skipQuoted = (start: number, quote: string): number => {
    let index = start + 1;
    while (index < source.length) {
      if (source[index] === '\\') index += 2;
      else if (source[index] === quote) return index + 1;
      else index++;
    }
    return source.length;
  };
  const skipTemplate = (start: number): number => {
    let index = start + 1;
    while (index < source.length) {
      if (source[index] === '\\') index += 2;
      else if (source[index] === '`') return index + 1;
      else if (source.startsWith('${', index)) index = skipTemplateExpression(index + 2);
      else index++;
    }
    return source.length;
  };
  const skipTemplateExpression = (start: number): number => {
    let depth = 1;
    let index = start;
    while (index < source.length) {
      if (source.startsWith('//', index)) {
        index = source.indexOf('\n', index + 2);
        if (index < 0) return source.length;
      } else if (source.startsWith('/*', index)) {
        const end = source.indexOf('*/', index + 2);
        index = end < 0 ? source.length : end + 2;
      } else if (source[index] === "'" || source[index] === '"') index = skipQuoted(index, source[index]!);
      else if (source[index] === '`') index = skipTemplate(index);
      else if (source[index] === '{') {
        depth++;
        index++;
      } else if (source[index] === '}') {
        index++;
        if (--depth === 0) return index;
      } else index++;
    }
    return source.length;
  };

  for (let index = 0; index < source.length;) {
    if (source.startsWith('//', index)) {
      let end = source.indexOf('\n', index + 2);
      if (end < 0) end = source.length;
      blank(index, end);
      index = end;
    } else if (source.startsWith('/*', index)) {
      const end = source.indexOf('*/', index + 2);
      const after = end < 0 ? source.length : end + 2;
      blank(index, after);
      index = after;
    } else if (source[index] === "'" || source[index] === '"' || source[index] === '`') {
      const kind = source[index] === '`' ? 'template' : 'string';
      const end = kind === 'template' ? skipTemplate(index) : skipQuoted(index, source[index]!);
      literals.push({ start: index, end, kind });
      blank(index, end);
      characters[index] = source[index]!;
      if (end > index + 1) characters[end - 1] = source[end - 1]!;
      index = end;
    } else index++;
  }
  return { code: characters.join(''), literals };
}

function matchingDelimiter(code: string, start: number): number | undefined {
  const expected: string[] = [];
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  for (let index = start; index < code.length; index++) {
    const character = code[index]!;
    if (pairs[character]) expected.push(pairs[character]!);
    else if (character === ')' || character === ']' || character === '}') {
      if (expected.pop() !== character) return undefined;
      if (expected.length === 0) return index;
    }
  }
  return undefined;
}

function skipSpace(code: string, index: number, end: number): number {
  while (index < end && /\s/.test(code[index]!)) index++;
  return index;
}

function splitArguments(code: string, open: number, close: number): { start: number; end: number }[] {
  const arguments_: { start: number; end: number }[] = [];
  const stack: string[] = [];
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  let start = open + 1;
  for (let index = start; index < close; index++) {
    const character = code[index]!;
    if (pairs[character]) stack.push(pairs[character]!);
    else if (character === ')' || character === ']' || character === '}') stack.pop();
    else if (character === ',' && stack.length === 0) {
      arguments_.push({ start, end: index });
      start = index + 1;
    }
  }
  if (start < close || arguments_.length > 0) arguments_.push({ start, end: close });
  return arguments_;
}

function topLevelEnd(code: string, start: number, end: number): number {
  const stack: string[] = [];
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  for (let index = start; index < end; index++) {
    const character = code[index]!;
    if (pairs[character]) stack.push(pairs[character]!);
    else if (character === ')' || character === ']' || character === '}') stack.pop();
    else if (character === ',' && stack.length === 0) return index;
  }
  return end;
}

function findNameValue(code: string, open: number, close: number): { start: number; end: number } | undefined {
  const stack: string[] = [];
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  for (let index = open + 1; index < close;) {
    if (stack.length === 0 && /[A-Za-z_$]/.test(code[index]!)) {
      const start = index++;
      while (index < close && /[\w$]/.test(code[index]!)) index++;
      if (code.slice(start, index) === 'name') {
        const colon = skipSpace(code, index, close);
        if (code[colon] === ':') {
          const valueStart = skipSpace(code, colon + 1, close);
          return { start: valueStart, end: topLevelEnd(code, valueStart, close) };
        }
      }
      continue;
    }
    const character = code[index]!;
    if (pairs[character]) stack.push(pairs[character]!);
    else if (character === ')' || character === ']' || character === '}') stack.pop();
    index++;
  }
  return undefined;
}

function literalText(source: string, literal: Literal): string | undefined {
  const content = source.slice(literal.start + 1, literal.end - 1);
  return content.includes('\\') ? undefined : content;
}

function quotedArrayChoices(
  source: string,
  code: string,
  literals: readonly Literal[],
  start: number,
  end: number,
): string[] | undefined {
  const literalAt = new Map(literals.map((literal) => [literal.start, literal]));
  const choices: string[] = [];
  let index = start + 1;
  while (index < end) {
    index = skipSpace(code, index, end);
    if (index === end) return choices.length ? choices : undefined;
    const literal = literalAt.get(index);
    if (!literal || literal.kind !== 'string' || literal.end > end) return undefined;
    const value = literalText(source, literal);
    if (value === undefined) return undefined;
    choices.push(value);
    index = skipSpace(code, literal.end, end);
    if (index === end) return choices;
    if (code[index] !== ',') return undefined;
    index++;
  }
  return choices.length ? choices : undefined;
}

function loopChoices(
  source: string,
  code: string,
  literals: readonly Literal[],
  name: string,
  callStart: number,
): string[] | undefined {
  for (const loop of code.matchAll(/\bfor\s*\(/g)) {
    const open = code.indexOf('(', loop.index);
    const close = matchingDelimiter(code, open);
    if (close === undefined || close >= callStart) continue;
    const header = code.slice(open + 1, close);
    const declaration = header.match(/^\s*const\s+([A-Za-z_$][\w$]*)\s+of\s*\[/);
    if (!declaration || declaration[1] !== name) continue;
    const axisOpen = open + 1 + header.indexOf('[', declaration[0].length - 1);
    const axisClose = matchingDelimiter(code, axisOpen);
    if (axisClose === undefined || axisClose > close) continue;
    const body = skipSpace(code, close + 1, code.length);
    let bodyEnd: number;
    if (code[body] === '{') {
      const closingBody = matchingDelimiter(code, body);
      if (closingBody === undefined) continue;
      bodyEnd = closingBody;
    } else {
      const semicolon = code.indexOf(';', body);
      const newline = code.indexOf('\n', body);
      bodyEnd =
        semicolon < 0 ? (newline < 0 ? code.length : newline) : newline < 0 ? semicolon : Math.min(semicolon, newline);
    }
    if (callStart < body || callStart > bodyEnd) continue;
    return quotedArrayChoices(source, code, literals, axisOpen, axisClose);
  }
  return undefined;
}

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function templateMatches(
  source: string,
  literal: Literal,
  name: string,
  code: string,
  literals: readonly Literal[],
  callStart: number,
): boolean {
  const template = literalText(source, literal);
  if (template === undefined) return false;
  if (!template.includes('${')) return template === name;
  let pattern = '^';
  let previous = 0;
  for (const interpolation of template.matchAll(/\$\{([^}]+)\}/g)) {
    pattern += escapePattern(template.slice(previous, interpolation.index));
    const expression = interpolation[1]!.trim();
    let choices: string[] | undefined;
    const conditional = expression.match(/^[A-Za-z_$][\w$]*\s*\?\s*('[^'\\]*'|"[^"\\]*")\s*:\s*('[^'\\]*'|"[^"\\]*")$/);
    if (conditional) choices = [conditional[1]!.slice(1, -1), conditional[2]!.slice(1, -1)];
    else if (/^[A-Za-z_$][\w$]*$/.test(expression))
      choices = loopChoices(source, code, literals, expression, callStart);
    if (!choices?.length) return false;
    pattern += `(?:${choices.map(escapePattern).join('|')})`;
    previous = interpolation.index + interpolation[0].length;
  }
  return previous > 0 && new RegExp(`${pattern}${escapePattern(template.slice(previous))}$`).test(name);
}

/** Match only names declared on a checkGrowth call, without executing its fixture module. */
function containsCheckName(source: string, name: string): boolean {
  const { code, literals } = maskNonCode(source);
  const literalAt = new Map(literals.map((literal) => [literal.start, literal]));
  for (const match of code.matchAll(/\bcheckGrowth\b/g)) {
    const open = skipSpace(code, match.index! + match[0].length, code.length);
    if (code[open] !== '(') continue;
    const close = matchingDelimiter(code, open);
    if (close === undefined) continue;
    const args = splitArguments(code, open, close);
    if (args.length < 2) continue;
    let { start, end } = args[1]!;
    start = skipSpace(code, start, end);
    while (code[start] === '(') {
      const wrappedEnd = matchingDelimiter(code, start);
      if (wrappedEnd !== end - 1) break;
      start++;
      end = wrappedEnd;
      start = skipSpace(code, start, end);
    }
    if (code[start] !== '{') continue;
    const objectEnd = matchingDelimiter(code, start);
    if (objectEnd === undefined || objectEnd > end) continue;
    const value = findNameValue(code, start, objectEnd);
    if (!value) continue;
    const literal = literalAt.get(value.start);
    if (!literal || literal.end > value.end) continue;
    if (literal.kind === 'string' && literalText(source, literal) === name) return true;
    if (literal.kind === 'template' && templateMatches(source, literal, name, code, literals, match.index!))
      return true;
  }
  return false;
}

export function validateGrowthBaseline(entries: readonly GrowthBaselineEntry[] = GROWTH_BASELINE): void {
  const names = new Set<string>();
  for (const entry of entries) {
    if (names.has(entry.name)) throw new TypeError(`Duplicate growth baseline name: ${entry.name}`);
    names.add(entry.name);
    if (!entry.name.trim()) throw new TypeError('Growth baseline name must not be empty');
    if (!entry.reason.trim()) throw new TypeError(`Growth baseline entry ${entry.name} must have a reason`);
    if (!/^services\/(?:kernel|auth)\/test\/.+\.test\.ts$/.test(entry.file) || entry.file.split('/').includes('..'))
      throw new TypeError(`Growth baseline entry ${entry.name} must name a kernel or auth test file`);
    let source: string;
    try {
      source = readFileSync(resolve(repositoryRoot, entry.file), 'utf8');
    } catch {
      throw new TypeError(`Growth baseline entry ${entry.name} names missing test file ${entry.file}`);
    }
    if (!containsCheckName(source, entry.name))
      throw new TypeError(`Growth baseline entry ${entry.name} is not present in ${entry.file}`);
  }
}

validateGrowthBaseline();

/** Unrelated production-shaped histories keep the anchor's 64/512/4096 matching degrees unchanged. */
export const RELATION_HISTORY_BASE = 4_096;
export const RELATION_HISTORY_PER_NEIGHBOUR = 4;

/** Seed a fixed history baseline before the first measured scale, then grow it with relation degree. */
export async function growRelationHistory(
  database: GrowthDatabase,
  population: Population,
  scale: number,
  previous: number,
): Promise<void> {
  const from = previous === 0 ? 0 : RELATION_HISTORY_BASE + RELATION_HISTORY_PER_NEIGHBOUR * previous;
  const to = RELATION_HISTORY_BASE + RELATION_HISTORY_PER_NEIGHBOUR * scale;
  await seed(database, population, { from, to });
}

/** Read actual table and partial-index source cardinalities outside the measured operation. */
export async function readRelationGrowthCardinalities(database: GrowthDatabase): Promise<Record<string, number>> {
  const sizes: Record<string, number> = {};
  for (const table of [
    'semantic.subject',
    'semantic.fact',
    'semantic.revision',
    'semantic.outbound_link',
    'semantic.outbound_link_count',
    'core.receipt',
    'core.outbox',
    'editorial.write_basis',
  ]) {
    const result = await database.admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
    sizes[table] = Number(result.rows[0]!.n);
  }
  const partial = await database.admin.query<{ terms: string; labels: string }>(
    `SELECT count(*) FILTER (WHERE kind <> 'statement')::text AS terms,
      count(*) FILTER (WHERE kind = 'label' AND operation = 'assert')::text AS labels FROM semantic.fact`,
  );
  sizes['semantic.fact_terms'] = Number(partial.rows[0]!.terms);
  sizes['semantic.fact_label'] = Number(partial.rows[0]!.labels);
  return sizes;
}
