import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect } from 'bun:test';

export type CostTableOptions = { testRoot: string; repositoryRoot: string };
export type CostRow = { operation: string; touches: string; bound: string; check: string };

type TableRow = { cells: string[]; line: number };
type CostTable = { rows: TableRow[] };
type TemplatePattern = { fixedParts: string[] };
type TemplateScan = { pattern: TemplatePattern; end: number };
type GrowthCheckTitle = { kind: 'literal'; value: string } | { kind: 'template'; value: TemplatePattern };

const COST_HEADER = ['Operation', 'Touches', 'Bound', 'Growth check'];
const TABLE_CONTEXT = '<table>';

export function readCostTable(readmePath: string): CostRow[] {
  const markdown = readFileSync(readmePath, 'utf8');
  const tables = findCostTables(markdown);
  if (tables.headings.length !== 1 || tables.tables.length !== 1) return [];

  return tables.tables[0]!.rows.map(({ cells }) => ({
    operation: cells[0]?.trim() ?? '',
    touches: cells[1]?.trim() ?? '',
    bound: cells[2]?.trim() ?? '',
    check: cells[3]?.trim() ?? '',
  }));
}

export function costTableProblems(readmePath: string, options: CostTableOptions): string[] {
  let markdown: string;
  try {
    markdown = readFileSync(readmePath, 'utf8');
  } catch (error) {
    return [problem(readmePath, TABLE_CONTEXT, `could not read README: ${errorMessage(error)}`)];
  }

  const parsed = findCostTables(markdown);
  const problems: string[] = [];
  if (parsed.headings.length !== 1) {
    problems.push(
      problem(readmePath, TABLE_CONTEXT, `expected exactly one "## Cost" heading, found ${parsed.headings.length}`),
    );
    return problems;
  }

  if (parsed.tables.length !== 1) {
    const reason =
      parsed.tables.length === 0
        ? (parsed.tableFailure ?? `expected a table headed by ${formatHeader()}`)
        : `expected one Cost table headed by ${formatHeader()}, found ${parsed.tables.length}`;
    problems.push(problem(readmePath, TABLE_CONTEXT, reason));
    return problems;
  }

  const rows = parsed.tables[0]!.rows;
  const seenOperations = new Set<string>();
  for (let index = 0; index < rows.length; index++) {
    const { cells, line } = rows[index]!;
    const operation = cells[0]?.trim() ?? '';
    const operationLabel = operation || `row ${line} (empty operation)`;
    const rowProblems: string[] = [];

    if (cells.length !== 4) {
      rowProblems.push(`expected four cells, found ${cells.length}`);
    }
    if (cells.length === 4 && cells.some((cell) => cell.trim().length === 0)) {
      rowProblems.push('every cell must be non-empty');
    }

    const operationKey = normalizeWhitespace(operation);
    if (operationKey.length > 0) {
      if (seenOperations.has(operationKey)) rowProblems.push('operation is duplicated in the Cost table');
      seenOperations.add(operationKey);
    }

    const bound = cells.length === 4 ? (cells[2]?.trim() ?? '') : '';
    if (bound && !/\b(?:constant|logarithmic|linear)\b/i.test(bound)) {
      rowProblems.push('bound must contain "constant", "logarithmic" or "linear"');
    }

    const check = cells.length === 4 ? (cells[3]?.trim() ?? '') : '';
    if (check) rowProblems.push(...checkProblems(check, options));

    for (const reason of rowProblems) problems.push(problem(readmePath, operationLabel, reason));
  }

  return problems;
}

export function expectCostTable(readmePath: string, options: CostTableOptions): void {
  expect(costTableProblems(readmePath, options)).toEqual([]);
}

function findCostTables(markdown: string): {
  headings: number[];
  tables: CostTable[];
  tableFailure?: string;
} {
  const lines = markdown.split(/\r?\n/);
  const visibleLines = hideFencedCode(lines);
  const headings = visibleLines.flatMap((line, index) => (isCostHeading(line) ? [index] : []));
  if (headings.length !== 1) return { headings, tables: [] };

  const start = headings[0]! + 1;
  let end = visibleLines.length;
  for (let index = start; index < visibleLines.length; index++) {
    const level = headingLevel(visibleLines[index]!);
    if (level !== undefined && level <= 2) {
      end = index;
      break;
    }
  }

  const tables: CostTable[] = [];
  let foundHeader = false;
  let invalidSeparator = false;
  for (let index = start; index < end; index++) {
    const cells = parseMarkdownRow(visibleLines[index]!);
    if (!cells || !isCostHeader(cells)) continue;
    foundHeader = true;
    const separator = visibleLines[index + 1];
    const separatorCells = separator === undefined ? null : parseMarkdownRow(separator);
    if (!separatorCells || !isSeparator(separatorCells)) {
      invalidSeparator = true;
      continue;
    }

    const rows: TableRow[] = [];
    for (let rowIndex = index + 2; rowIndex < end; rowIndex++) {
      const line = visibleLines[rowIndex]!;
      if (line.trim().length === 0 || headingLevel(line) !== undefined) break;
      const rowCells = parseMarkdownRow(line);
      if (!rowCells) break;
      if (isSeparator(rowCells)) continue;
      rows.push({ cells: rowCells.map((cell) => cell.trim()), line: rowIndex + 1 });
    }
    tables.push({ rows });
  }

  if (tables.length > 0) return { headings, tables };
  if (foundHeader && invalidSeparator) {
    return {
      headings,
      tables,
      tableFailure: `the Cost table headed by ${formatHeader()} needs a four-column Markdown separator`,
    };
  }
  return {
    headings,
    tables,
    tableFailure: `expected a table with header ${formatHeader()}`,
  };
}

function hideFencedCode(lines: string[]): string[] {
  const visible: string[] = [];
  let fence: { marker: '`' | '~'; length: number } | undefined;

  for (const line of lines) {
    if (fence) {
      const close = new RegExp(`^ {0,3}${escapeRegExp(fence.marker)}{${fence.length},}\\s*$`);
      if (close.test(line)) fence = undefined;
      visible.push('');
      continue;
    }

    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (opening) {
      const openingFence = opening[1]!;
      const marker = openingFence[0] as '`' | '~';
      fence = { marker, length: openingFence.length };
      visible.push('');
    } else {
      visible.push(line);
    }
  }

  return visible;
}

function isCostHeading(line: string): boolean {
  return /^ {0,3}##[ \t]+Cost[ \t]*(?:#+[ \t]*)?$/.test(line);
}

function headingLevel(line: string): number | undefined {
  const match = /^ {0,3}(#{1,6})(?:[ \t]+|$)/.exec(line);
  return match ? match[1]!.length : undefined;
}

function parseMarkdownRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) return null;

  const cells: string[] = [];
  let current = '';
  let backslashes = 0;
  for (let index = 0; index < trimmed.length; index++) {
    const character = trimmed[index];
    if (character === '|' && backslashes % 2 === 0) {
      cells.push(current);
      current = '';
    } else {
      current += character;
    }
    backslashes = character === '\\' ? backslashes + 1 : 0;
  }
  cells.push(current);

  if (trimmed.startsWith('|')) cells.shift();
  if (trimmed.endsWith('|') && !isEscaped(trimmed, trimmed.length - 1)) cells.pop();
  return cells;
}

function isEscaped(value: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor--) backslashes++;
  return backslashes % 2 === 1;
}

function isCostHeader(cells: string[]): boolean {
  return (
    cells.length === COST_HEADER.length &&
    cells.every((cell, index) => normalizeWhitespace(cell) === COST_HEADER[index]!)
  );
}

function isSeparator(cells: string[]): boolean {
  return cells.length === 4 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function formatHeader(): string {
  return `| ${COST_HEADER.join(' | ')} |`;
}

function checkProblems(check: string, options: CostTableOptions): string[] {
  const none = /^None:(.*)$/s.exec(check);
  if (none) {
    const reason = none[1]!.trim();
    if ([...reason].length < 20) return ['"None:" needs a reason of at least 20 characters'];
    return [];
  }

  const citations = findCitations(check);
  if (citations.length === 0) {
    return ['growth check must be a test citation or "None:" followed by a reason'];
  }

  const problems: string[] = [];
  for (const citation of citations) {
    if (citation.problem) {
      problems.push(citation.problem);
      continue;
    }
    const base = citation.path.startsWith('services/') ? options.repositoryRoot : options.testRoot;
    const testPath = resolve(base, citation.path);
    let source: string;
    try {
      if (!existsSync(testPath)) {
        problems.push(`growth check file "${citation.path}" does not exist`);
        continue;
      }
      source = readFileSync(testPath, 'utf8');
    } catch (error) {
      problems.push(`growth check file "${citation.path}" could not be read: ${errorMessage(error)}`);
      continue;
    }

    const titles = scanGrowthCheckTitles(source);
    for (const name of citation.names) {
      if (!titles.some((title) => growthCheckTitleMatches(title, name))) {
        problems.push(`growth check name "${name}" was not found in a declared test in "${citation.path}"`);
      }
    }
  }

  return problems;
}

type Citation = { path: string; names: string[]; problem?: string };
type CitationMatch = { path: string; start: number; contentStart: number };

function findCitations(value: string): Citation[] {
  const matches: CitationMatch[] = [];
  const pathPattern = /`([^`\r\n]+\.test\.ts)`[ \t]*:/g;
  for (const match of value.matchAll(pathPattern)) {
    matches.push({
      path: match[1]!,
      start: match.index ?? 0,
      contentStart: (match.index ?? 0) + match[0].length,
    });
  }

  return matches.map((match, index) => {
    const nextStart = matches[index + 1]?.start ?? value.length;
    const parsed = readCitationNames(value.slice(match.contentStart, nextStart));
    return {
      path: match.path,
      names: parsed.names,
      ...(parsed.invalid ? { problem: `growth check citation for "${match.path}" must name one or more checks` } : {}),
    };
  });
}

function readCitationNames(value: string): { names: string[]; invalid: boolean } {
  const names: string[] = [];
  let cursor = 0;
  let requiresName = true;

  while (cursor < value.length) {
    while (/\s/.test(value[cursor] ?? '') && cursor < value.length) cursor++;
    if (value[cursor] !== '“' && value[cursor] !== '`') {
      if (requiresName && names.length === 0) return { names, invalid: true };
      break;
    }

    const quote = value[cursor] as '“' | '`';
    const close = quote === '“' ? '”' : '`';
    const contentStart = cursor + 1;
    const closeIndex = quote === '“' ? value.indexOf(close, contentStart) : findClosingBacktick(value, contentStart);
    if (closeIndex < 0) return { names, invalid: true };
    const name = value.slice(contentStart, closeIndex).trim();
    if (name.length === 0) return { names, invalid: true };
    names.push(name);
    cursor = closeIndex + 1;
    while (/\s/.test(value[cursor] ?? '') && cursor < value.length) cursor++;

    if (value[cursor] === ';') {
      cursor++;
      requiresName = true;
      continue;
    }
    if (/[“`]/.test(value.slice(cursor))) return { names, invalid: true };
    requiresName = false;
    break;
  }

  if (requiresName && names.length > 0) return { names, invalid: true };
  return { names, invalid: names.length === 0 };
}

function findClosingBacktick(value: string, start: number): number {
  for (let index = start; index < value.length; index++) {
    if (value[index] === '`' && !isEscaped(value, index)) return index;
  }
  return -1;
}

function scanGrowthCheckTitles(source: string): GrowthCheckTitle[] {
  const titles: GrowthCheckTitle[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const character = source[cursor];
    if (character === '/' && source[cursor + 1] === '/') {
      cursor = skipLineComment(source, cursor + 2);
    } else if (character === '/' && source[cursor + 1] === '*') {
      cursor = skipBlockComment(source, cursor + 2);
    } else if (character === "'" || character === '"') {
      cursor = skipQuotedString(source, cursor, character);
    } else if (character === '`') {
      const parsed = parseTemplate(source, cursor, []);
      if (!parsed) cursor++;
      else cursor = parsed.end;
    } else if (isIdentifierStart(character)) {
      const start = cursor;
      cursor++;
      while (isIdentifierPart(source[cursor])) cursor++;
      const identifier = source.slice(start, cursor);
      if ((identifier === 'test' || identifier === 'it') && !isPropertyReference(source, start)) {
        const parsed = parseGrowthCheckTitle(source, cursor);
        if (parsed) {
          titles.push(parsed.title);
          cursor = parsed.end;
        }
      }
    } else {
      cursor++;
    }
  }
  return titles;
}

function parseGrowthCheckTitle(source: string, start: number): { title: GrowthCheckTitle; end: number } | undefined {
  let cursor = skipTrivia(source, start);
  const modifiers: string[] = [];
  while (source[cursor] === '.') {
    cursor = skipTrivia(source, cursor + 1);
    if (!isIdentifierStart(source[cursor])) return undefined;
    const modifierStart = cursor++;
    while (isIdentifierPart(source[cursor])) cursor++;
    modifiers.push(source.slice(modifierStart, cursor));
    cursor = skipTrivia(source, cursor);
  }
  if (modifiers.some((modifier) => modifier === 'skip' || modifier === 'todo') || source[cursor] !== '(') {
    return undefined;
  }

  cursor = skipTrivia(source, cursor + 1);
  if (source[cursor] === "'" || source[cursor] === '"') {
    const parsed = readQuotedTitle(source, cursor);
    return parsed && isCompleteTitleArgument(source, parsed.end)
      ? { title: { kind: 'literal', value: parsed.value }, end: parsed.end }
      : undefined;
  }
  if (source[cursor] === '`') {
    const parsed = parseTemplate(source, cursor, []);
    if (!parsed || !isCompleteTitleArgument(source, parsed.end)) return undefined;
    const title =
      parsed.pattern.fixedParts.length === 1
        ? { kind: 'literal' as const, value: parsed.pattern.fixedParts[0]! }
        : { kind: 'template' as const, value: parsed.pattern };
    return { title, end: parsed.end };
  }
  return undefined;
}

function isCompleteTitleArgument(source: string, end: number): boolean {
  const next = skipTrivia(source, end);
  return source[next] === ',' || source[next] === ')';
}

function readQuotedTitle(source: string, start: number): { value: string; end: number } | undefined {
  const quote = source[start]!;
  let value = '';
  let cursor = start + 1;
  while (cursor < source.length) {
    const character = source[cursor]!;
    if (character === quote) return { value, end: cursor + 1 };
    if (character === '\n' || character === '\r') return undefined;
    if (character !== '\\') {
      value += character;
      cursor++;
      continue;
    }

    const escaped = source[cursor + 1];
    if (escaped === undefined) return undefined;
    if (escaped === '\n') {
      cursor += 2;
      continue;
    }
    if (escaped === '\r') {
      cursor += source[cursor + 2] === '\n' ? 3 : 2;
      continue;
    }
    const parsed = readQuotedEscape(source, cursor + 1);
    if (!parsed) return undefined;
    value += parsed.value;
    cursor = parsed.end;
  }
  return undefined;
}

function readQuotedEscape(source: string, start: number): { value: string; end: number } | undefined {
  const escaped = source[start]!;
  if (escaped === 'x') {
    const digits = source.slice(start + 1, start + 3);
    return /^[\da-f]{2}$/i.test(digits)
      ? { value: String.fromCharCode(Number.parseInt(digits, 16)), end: start + 3 }
      : undefined;
  }
  if (escaped === 'u') {
    if (source[start + 1] === '{') {
      const close = source.indexOf('}', start + 2);
      const digits = close < 0 ? '' : source.slice(start + 2, close);
      const point = Number.parseInt(digits, 16);
      return /^[\da-f]{1,6}$/i.test(digits) && point <= 0x10ffff
        ? { value: String.fromCodePoint(point), end: close + 1 }
        : undefined;
    }
    const digits = source.slice(start + 1, start + 5);
    return /^[\da-f]{4}$/i.test(digits)
      ? { value: String.fromCharCode(Number.parseInt(digits, 16)), end: start + 5 }
      : undefined;
  }
  return { value: decodeTemplateEscape(escaped), end: start + 1 };
}

function growthCheckTitleMatches(title: GrowthCheckTitle, name: string): boolean {
  return title.kind === 'literal' ? title.value === name : patternMatches(title.value, name);
}

function isPropertyReference(source: string, start: number): boolean {
  return source[start - 1] === '.' || (source[start - 1] === '?' && source[start - 2] === '.');
}

function isIdentifierStart(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z_$]/.test(character);
}

function isIdentifierPart(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z0-9_$]/.test(character);
}

function skipTrivia(source: string, start: number): number {
  let cursor = start;
  while (cursor < source.length) {
    if (/\s/.test(source[cursor]!)) cursor++;
    else if (source[cursor] === '/' && source[cursor + 1] === '/') cursor = skipLineComment(source, cursor + 2);
    else if (source[cursor] === '/' && source[cursor + 1] === '*') cursor = skipBlockComment(source, cursor + 2);
    else break;
  }
  return cursor;
}

function parseTemplate(source: string, start: number, nested: TemplatePattern[]): TemplateScan | undefined {
  const fixedParts: string[] = [];
  let fixed = '';
  let cursor = start + 1;

  while (cursor < source.length) {
    const character = source[cursor];
    if (character === '\\') {
      const escaped = source[cursor + 1];
      if (escaped === undefined) return undefined;
      fixed += decodeTemplateEscape(escaped);
      cursor += 2;
    } else if (character === '`') {
      fixedParts.push(fixed);
      return { pattern: { fixedParts }, end: cursor + 1 };
    } else if (character === '$' && source[cursor + 1] === '{') {
      fixedParts.push(fixed);
      fixed = '';
      cursor = skipTemplateExpression(source, cursor + 2, nested);
      if (cursor < 0) return undefined;
    } else {
      fixed += character;
      cursor++;
    }
  }
  return undefined;
}

function skipTemplateExpression(source: string, start: number, patterns: TemplatePattern[]): number {
  let depth = 1;
  let cursor = start;
  while (cursor < source.length) {
    const character = source[cursor];
    if (character === '/' && source[cursor + 1] === '/') {
      cursor = skipLineComment(source, cursor + 2);
    } else if (character === '/' && source[cursor + 1] === '*') {
      cursor = skipBlockComment(source, cursor + 2);
    } else if (character === "'" || character === '"') {
      cursor = skipQuotedString(source, cursor, character);
    } else if (character === '`') {
      const parsed = parseTemplate(source, cursor, patterns);
      if (!parsed) return -1;
      patterns.push(parsed.pattern);
      cursor = parsed.end;
    } else if (character === '{') {
      depth++;
      cursor++;
    } else if (character === '}') {
      depth--;
      if (depth === 0) return cursor + 1;
      cursor++;
    } else {
      cursor++;
    }
  }
  return -1;
}

function skipLineComment(source: string, start: number): number {
  const end = source.indexOf('\n', start);
  return end < 0 ? source.length : end + 1;
}

function skipBlockComment(source: string, start: number): number {
  const end = source.indexOf('*/', start);
  return end < 0 ? source.length : end + 2;
}

function skipQuotedString(source: string, start: number, quote: string): number {
  let cursor = start + 1;
  while (cursor < source.length) {
    if (source[cursor] === '\\') cursor += 2;
    else if (source[cursor] === quote) return cursor + 1;
    else cursor++;
  }
  return source.length;
}

function decodeTemplateEscape(value: string): string {
  switch (value) {
    case 'n':
      return '\n';
    case 'r':
      return '\r';
    case 't':
      return '\t';
    case 'b':
      return '\b';
    case 'f':
      return '\f';
    case 'v':
      return '\v';
    default:
      return value;
  }
}

function patternMatches(pattern: TemplatePattern, name: string): boolean {
  const fixedLength = pattern.fixedParts.reduce((total, part) => total + [...part].length, 0);
  if (fixedLength < 12) return false;

  if (pattern.fixedParts.length === 1) return pattern.fixedParts[0] === name;

  const first = pattern.fixedParts[0]!;
  if (!name.startsWith(first)) return false;
  return matchTemplateParts(pattern.fixedParts, name, 1, first.length);
}

function matchTemplateParts(parts: string[], name: string, index: number, position: number): boolean {
  const part = parts[index]!;
  if (index === parts.length - 1) {
    if (part.length === 0) return name.length - position > 0;
    const finalStart = name.length - part.length;
    return finalStart > position && name.startsWith(part, finalStart);
  }

  const minimumStart = position + 1;
  if (part.length === 0) {
    for (let next = minimumStart; next <= name.length; next++) {
      if (matchTemplateParts(parts, name, index + 1, next)) return true;
    }
    return false;
  }

  let next = name.indexOf(part, minimumStart);
  while (next >= 0) {
    if (matchTemplateParts(parts, name, index + 1, next + part.length)) return true;
    next = name.indexOf(part, next + 1);
  }
  return false;
}

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function problem(readmePath: string, operation: string, reason: string): string {
  return `${readmePath}: operation "${operation}": ${reason}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
