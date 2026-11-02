import { closeSync, openSync, readSync, statSync } from 'node:fs';
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

const MAX_BASELINE_ENTRIES = 512;
const MAX_BASELINE_NAME_LENGTH = 1_024;
const MAX_BASELINE_FILE_LENGTH = 512;
const MAX_BASELINE_REASON_LENGTH = 4_096;
const MAX_SOURCE_BYTES = 512 * 1_024;
const MAX_TOTAL_SOURCE_BYTES = 4 * 1_024 * 1_024;
const MAX_TOTAL_LEXICAL_WORK = 64 * 1_024 * 1_024;
const MAX_TEMPLATE_DEPTH = 128;
const MAX_TEMPLATE_CHOICES = 256;
const MAX_TEMPLATE_PARTS = 128;
const MAX_LEXICAL_LITERALS = 16_384;

// Each validation admits at most 512 KiB per source, 4 MiB total, and 64M lexical steps.
class BaselineScanLimitError extends Error {}

type ScanBudget = { remaining: number };

function charge(budget: ScanBudget, amount = 1): void {
  budget.remaining -= amount;
  if (budget.remaining < 0) throw new BaselineScanLimitError('lexical inspection work limit exceeded');
}

function readBoundedSource(path: string, admittedBytes: number): { source: string; bytes: number } {
  const limit = Math.min(MAX_SOURCE_BYTES, admittedBytes);
  const descriptor = openSync(path, 'r');
  try {
    const bytes = Buffer.allocUnsafe(limit + 1);
    let length = 0;
    while (length <= limit) {
      const read = readSync(descriptor, bytes, length, limit + 1 - length, null);
      if (read === 0) break;
      length += read;
    }
    if (length > limit) {
      const cause = admittedBytes < MAX_SOURCE_BYTES ? 'aggregate source byte limit exceeded' : 'source byte limit exceeded';
      throw new BaselineScanLimitError(cause);
    }
    return { source: bytes.toString('utf8', 0, length), bytes: length };
  } finally {
    closeSync(descriptor);
  }
}

type Literal = Readonly<{ start: number; end: number; kind: 'string' | 'template' }>;

function maskNonCode(source: string, budget: ScanBudget): { code: string; literals: readonly Literal[]; literalAt: ReadonlyMap<number, Literal> } {
  charge(budget, source.length);
  const characters = source.split('');
  const literals: Literal[] = [];
  const blank = (start: number, end: number) => {
    charge(budget, end - start);
    for (let index = start; index < end; index++)
      if (source[index] !== '\n' && source[index] !== '\r') characters[index] = ' ';
  };
  const skipQuoted = (start: number, quote: string): number => {
    charge(budget, source.length - start);
    let index = start + 1;
    while (index < source.length) {
      if (source[index] === '\\') index += 2;
      else if (source[index] === quote) return index + 1;
      else index++;
    }
    return source.length;
  };
  const skipTemplate = (start: number, templateDepth: number): number => {
    if (templateDepth > MAX_TEMPLATE_DEPTH) throw new BaselineScanLimitError('template nesting limit exceeded');
    charge(budget, source.length - start);
    let index = start + 1;
    while (index < source.length) {
      if (source[index] === '\\') index += 2;
      else if (source[index] === '`') return index + 1;
      else if (source.startsWith('${', index)) index = skipTemplateExpression(index + 2, templateDepth + 1);
      else index++;
    }
    return source.length;
  };
  const skipTemplateExpression = (start: number, templateDepth: number): number => {
    if (templateDepth > MAX_TEMPLATE_DEPTH) throw new BaselineScanLimitError('template nesting limit exceeded');
    charge(budget, source.length - start);
    let braceDepth = 1;
    let index = start;
    while (index < source.length) {
      if (source.startsWith('//', index)) {
        index = source.indexOf('\n', index + 2);
        if (index < 0) return source.length;
      } else if (source.startsWith('/*', index)) {
        const end = source.indexOf('*/', index + 2);
        index = end < 0 ? source.length : end + 2;
      } else if (source[index] === "'" || source[index] === '"') index = skipQuoted(index, source[index]!);
      else if (source[index] === '`') index = skipTemplate(index, templateDepth + 1);
      else if (source[index] === '{') {
        braceDepth++;
        index++;
      } else if (source[index] === '}') {
        index++;
        if (--braceDepth === 0) return index;
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
      if (literals.length >= MAX_LEXICAL_LITERALS) throw new BaselineScanLimitError('literal count limit exceeded');
      const end = kind === 'template' ? skipTemplate(index, 0) : skipQuoted(index, source[index]!);
      literals.push({ start: index, end, kind });
      blank(index, end);
      characters[index] = source[index]!;
      if (end > index + 1) characters[end - 1] = source[end - 1]!;
      index = end;
    } else index++;
  }
  const literalAt = new Map(literals.map((literal) => [literal.start, literal]));
  return { code: characters.join(''), literals, literalAt };
}

function matchingDelimiter(code: string, start: number, budget: ScanBudget): number | undefined {
  charge(budget, code.length - start);
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

function skipSpace(code: string, index: number, end: number, budget: ScanBudget): number {
  charge(budget, end - index);
  while (index < end && /\s/.test(code[index]!)) index++;
  return index;
}

function splitArguments(code: string, open: number, close: number, budget: ScanBudget): { start: number; end: number }[] {
  charge(budget, close - open);
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

function topLevelEnd(code: string, start: number, end: number, budget: ScanBudget): number {
  charge(budget, end - start);
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

function findNameValue(
  code: string,
  open: number,
  close: number,
  budget: ScanBudget,
): { start: number; end: number } | undefined {
  charge(budget, close - open);
  const stack: string[] = [];
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  for (let index = open + 1; index < close;) {
    if (stack.length === 0 && /[A-Za-z_$]/.test(code[index]!)) {
      const start = index++;
      while (index < close && /[\w$]/.test(code[index]!)) index++;
      if (code.slice(start, index) === 'name') {
        const colon = skipSpace(code, index, close, budget);
        if (code[colon] === ':') {
          const valueStart = skipSpace(code, colon + 1, close, budget);
          return { start: valueStart, end: topLevelEnd(code, valueStart, close, budget) };
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

function literalText(source: string, literal: Literal, budget: ScanBudget): string | undefined {
  charge(budget, literal.end - literal.start);
  const content = source.slice(literal.start + 1, literal.end - 1);
  return content.includes('\\') ? undefined : content;
}

function quotedArrayChoices(
  source: string,
  code: string,
  literalAt: ReadonlyMap<number, Literal>,
  start: number,
  end: number,
  budget: ScanBudget,
): string[] | undefined {
  charge(budget, end - start);
  const choices: string[] = [];
  let index = start + 1;
  while (index < end) {
    index = skipSpace(code, index, end, budget);
    if (index === end) return choices.length ? choices : undefined;
    const literal = literalAt.get(index);
    if (!literal || literal.kind !== 'string' || literal.end > end) return undefined;
    const value = literalText(source, literal, budget);
    if (value === undefined) return undefined;
    if (choices.length >= MAX_TEMPLATE_CHOICES) throw new BaselineScanLimitError('template choice limit exceeded');
    choices.push(value);
    index = skipSpace(code, literal.end, end, budget);
    if (index === end) return choices;
    if (code[index] !== ',') return undefined;
    index++;
  }
  return choices.length ? choices : undefined;
}

function loopChoices(
  source: string,
  code: string,
  literalAt: ReadonlyMap<number, Literal>,
  name: string,
  callStart: number,
  budget: ScanBudget,
): string[] | undefined {
  charge(budget, code.length);
  for (const loop of code.matchAll(/\bfor\s*\(/g)) {
    const open = code.indexOf('(', loop.index);
    const close = matchingDelimiter(code, open, budget);
    if (close === undefined || close >= callStart) continue;
    const header = code.slice(open + 1, close);
    const declaration = header.match(/^\s*const\s+([A-Za-z_$][\w$]*)\s+of\s*\[/);
    if (!declaration || declaration[1] !== name) continue;
    const axisOpen = open + 1 + header.indexOf('[', declaration[0].length - 1);
    const axisClose = matchingDelimiter(code, axisOpen, budget);
    if (axisClose === undefined || axisClose > close) continue;
    const body = skipSpace(code, close + 1, code.length, budget);
    let bodyEnd: number;
    if (code[body] === '{') {
      const closingBody = matchingDelimiter(code, body, budget);
      if (closingBody === undefined) continue;
      bodyEnd = closingBody;
    } else {
      const semicolon = code.indexOf(';', body);
      const newline = code.indexOf('\n', body);
      bodyEnd =
        semicolon < 0 ? (newline < 0 ? code.length : newline) : newline < 0 ? semicolon : Math.min(semicolon, newline);
    }
    if (callStart < body || callStart > bodyEnd) continue;
    return quotedArrayChoices(source, code, literalAt, axisOpen, axisClose, budget);
  }
  return undefined;
}

function templateMatches(
  source: string,
  literal: Literal,
  name: string,
  code: string,
  literalAt: ReadonlyMap<number, Literal>,
  callStart: number,
  budget: ScanBudget,
): boolean {
  const template = literalText(source, literal, budget);
  if (template === undefined) return false;
  charge(budget, template.length);
  if (!template.includes('${')) return template === name;
  const parts: { prefix: string; choices: string[] }[] = [];
  let cursor = 0;
  while (cursor < template.length) {
    const open = template.indexOf('${', cursor);
    if (open < 0) break;
    const close = template.indexOf('}', open + 2);
    if (close < 0) return false;
    if (parts.length >= MAX_TEMPLATE_PARTS) throw new BaselineScanLimitError('template interpolation limit exceeded');
    const expression = template.slice(open + 2, close).trim();
    charge(budget, expression.length);
    let choices: string[] | undefined;
    const conditional = expression.match(/^[A-Za-z_$][\w$]*\s*\?\s*('[^'\\]*'|"[^"\\]*")\s*:\s*('[^'\\]*'|"[^"\\]*")$/);
    if (conditional) choices = [conditional[1]!.slice(1, -1), conditional[2]!.slice(1, -1)];
    else if (/^[A-Za-z_$][\w$]*$/.test(expression))
      choices = loopChoices(source, code, literalAt, expression, callStart, budget);
    if (!choices?.length) return false;
    if (choices.length > MAX_TEMPLATE_CHOICES) throw new BaselineScanLimitError('template choice limit exceeded');
    parts.push({ prefix: template.slice(cursor, open), choices });
    cursor = close + 1;
  }
  if (!parts.length) return template === name;

  let positions = new Set<number>([0]);
  for (const part of parts) {
    const afterPrefix = new Set<number>();
    for (const position of positions) {
      charge(budget, part.prefix.length + 1);
      if (name.startsWith(part.prefix, position)) afterPrefix.add(position + part.prefix.length);
    }
    const afterChoice = new Set<number>();
    for (const position of afterPrefix) {
      for (const choice of part.choices) {
        charge(budget, Math.min(choice.length, Math.max(0, name.length - position)) + 1);
        if (name.startsWith(choice, position)) afterChoice.add(position + choice.length);
      }
    }
    positions = afterChoice;
    if (!positions.size) return false;
  }
  const suffix = template.slice(cursor);
  for (const position of positions) {
    charge(budget, suffix.length + 1);
    if (position + suffix.length === name.length && name.startsWith(suffix, position)) return true;
  }
  return false;
}

/** Match only names declared on a checkGrowth call, without executing its fixture module. */
function containsCheckName(
  source: string,
  name: string,
  inspection: ReturnType<typeof maskNonCode>,
  budget: ScanBudget,
): boolean {
  const { code, literalAt } = inspection;
  charge(budget, code.length);
  for (const match of code.matchAll(/\bcheckGrowth\b/g)) {
    const open = skipSpace(code, match.index! + match[0].length, code.length, budget);
    if (code[open] !== '(') continue;
    const close = matchingDelimiter(code, open, budget);
    if (close === undefined) continue;
    const args = splitArguments(code, open, close, budget);
    if (args.length < 2) continue;
    let { start, end } = args[1]!;
    start = skipSpace(code, start, end, budget);
    while (code[start] === '(') {
      const wrappedEnd = matchingDelimiter(code, start, budget);
      if (wrappedEnd !== end - 1) break;
      start++;
      end = wrappedEnd;
      start = skipSpace(code, start, end, budget);
    }
    if (code[start] !== '{') continue;
    const objectEnd = matchingDelimiter(code, start, budget);
    if (objectEnd === undefined || objectEnd > end) continue;
    const value = findNameValue(code, start, objectEnd, budget);
    if (!value) continue;
    const literal = literalAt.get(value.start);
    if (!literal || literal.end > value.end) continue;
    if (literal.kind === 'string' && literalText(source, literal, budget) === name) return true;
    if (
      literal.kind === 'template' &&
      templateMatches(source, literal, name, code, literalAt, match.index!, budget)
    )
      return true;
  }
  return false;
}

export function validateGrowthBaseline(entries: readonly GrowthBaselineEntry[] = GROWTH_BASELINE): void {
  if (entries.length > MAX_BASELINE_ENTRIES)
    throw new TypeError(`Growth baseline entry list exceeds ${MAX_BASELINE_ENTRIES} entries`);
  const names = new Set<string>();
  const files = new Map<
    string,
    {
      file: string;
      firstEntry: GrowthBaselineEntry;
      entries: GrowthBaselineEntry[];
      path: string;
      size: number;
      source?: string;
      inspection?: ReturnType<typeof maskNonCode>;
    }
  >();
  for (const entry of entries) {
    if (names.has(entry.name)) throw new TypeError(`Duplicate growth baseline name: ${entry.name}`);
    names.add(entry.name);
    if (entry.name.length > MAX_BASELINE_NAME_LENGTH)
      throw new TypeError(`Growth baseline entry name exceeds ${MAX_BASELINE_NAME_LENGTH} characters`);
    if (!entry.name.trim()) throw new TypeError('Growth baseline name must not be empty');
    if (entry.reason.length > MAX_BASELINE_REASON_LENGTH)
      throw new TypeError(`Growth baseline entry ${entry.name} reason exceeds ${MAX_BASELINE_REASON_LENGTH} characters`);
    if (!entry.reason.trim()) throw new TypeError(`Growth baseline entry ${entry.name} must have a reason`);
    if (entry.file.length > MAX_BASELINE_FILE_LENGTH)
      throw new TypeError(`Growth baseline entry ${entry.name} file path exceeds ${MAX_BASELINE_FILE_LENGTH} characters`);
    if (!/^services\/(?:kernel|auth)\/test\/.+\.test\.ts$/.test(entry.file) || entry.file.split('/').includes('..'))
      throw new TypeError(`Growth baseline entry ${entry.name} must name a kernel or auth test file`);
    const group = files.get(entry.file);
    if (group) group.entries.push(entry);
    else files.set(entry.file, { file: entry.file, firstEntry: entry, entries: [entry], path: resolve(repositoryRoot, entry.file), size: 0 });
  }

  let admittedBytes = 0;
  let admittedLexicalWork = 0;
  for (const group of files.values()) {
    try {
      const metadata = statSync(group.path);
      if (!metadata.isFile()) throw new Error('not a file');
      group.size = metadata.size;
    } catch {
      throw new TypeError(`Growth baseline entry ${group.firstEntry.name} names missing test file ${group.file}`);
    }
    if (group.size > MAX_SOURCE_BYTES)
      throw new TypeError(
        `Growth baseline entry ${group.firstEntry.name} cannot inspect ${group.file}: source byte limit exceeded`,
      );
    admittedBytes += group.size;
    if (admittedBytes > MAX_TOTAL_SOURCE_BYTES)
      throw new TypeError(
        `Growth baseline entry ${group.firstEntry.name} cannot inspect ${group.file}: aggregate source byte limit exceeded`,
      );
    admittedLexicalWork += (group.size + 1) * (group.entries.length + 1);
    if (admittedLexicalWork > MAX_TOTAL_LEXICAL_WORK)
      throw new TypeError(
        `Growth baseline entry ${group.firstEntry.name} cannot inspect ${group.file}: lexical work admission limit exceeded`,
      );
  }

  const budget: ScanBudget = { remaining: MAX_TOTAL_LEXICAL_WORK };
  let actualBytes = 0;
  for (const group of files.values()) {
    try {
      const snapshot = readBoundedSource(group.path, MAX_TOTAL_SOURCE_BYTES - actualBytes);
      actualBytes += snapshot.bytes;
      group.source = snapshot.source;
      group.inspection = maskNonCode(snapshot.source, budget);
    } catch (error) {
      if (error instanceof BaselineScanLimitError)
        throw new TypeError(
          `Growth baseline entry ${group.firstEntry.name} cannot inspect ${group.file}: ${error.message}`,
        );
      throw new TypeError(`Growth baseline entry ${group.firstEntry.name} names missing test file ${group.file}`);
    }
  }

  for (const entry of entries) {
    const group = files.get(entry.file)!;
    const inspection = group.inspection!;
    let present: boolean;
    try {
      present = containsCheckName(group.source!, entry.name, inspection, budget);
    } catch (error) {
      if (error instanceof BaselineScanLimitError)
        throw new TypeError(`Growth baseline entry ${entry.name} cannot inspect ${entry.file}: ${error.message}`);
      throw error;
    }
    if (!present)
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
