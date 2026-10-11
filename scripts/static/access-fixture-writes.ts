import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';

const sourceRoots = ['apps', 'services', 'tests', 'scripts', 'packages'];
const sourceExtensions = new Set(['.ts', '.tsx', '.mts', '.cts']);
const templateTable = '__ACCESS_FIXTURE_TABLE_TEMPLATE__';
const tableNames = ['permission_grant', 'representation', 'scope_gate'] as const;
const tableNameSet = new Set<string>(tableNames);

export type AccessFixtureWriteTable = `access.${(typeof tableNames)[number]}` | 'access.<template table>';

export interface AccessFixtureWrite {
  file: string;
  table: AccessFixtureWriteTable;
}

function decodeEscape(char: string): string {
  if (char === 'n') return '\n';
  if (char === 'r') return '\r';
  if (char === 't') return '\t';
  return char;
}

function readQuoted(source: string, start: number, quote: string): { value: string; end: number } {
  let value = '';
  let cursor = start + 1;
  while (cursor < source.length && source[cursor] !== quote) {
    if (source[cursor] === '\\') {
      value += decodeEscape(source[cursor + 1] ?? '');
      cursor += 2;
    } else {
      value += source[cursor];
      cursor += 1;
    }
  }
  return { value, end: Math.min(cursor + 1, source.length) };
}

function skipRegex(source: string, start: number): number {
  let cursor = start + 1;
  let inCharacterClass = false;
  while (cursor < source.length) {
    const char = source[cursor]!;
    if (char === '\\') { cursor += 2; continue; }
    if (char === '[') inCharacterClass = true;
    else if (char === ']') inCharacterClass = false;
    else if (char === '/' && !inCharacterClass) {
      cursor += 1;
      while (cursor < source.length && /[a-z]/i.test(source[cursor]!)) cursor += 1;
      return cursor;
    }
    if (char === '\n' || char === '\r') return cursor;
    cursor += 1;
  }
  return cursor;
}

function scanCode(source: string, start: number, stopAtTemplateBrace: boolean, literals: string[]): number {
  let cursor = start;
  let braceDepth = 0;
  let previous = '';
  const canStartRegex = () => !previous || ['(', '[', '{', '=', ':', ',', ';', '!', '?', '=>',
    'return', 'case', 'throw', 'yield', 'await', 'typeof', 'void', 'delete', 'in', 'of'].includes(previous);

  while (cursor < source.length) {
    const char = source[cursor]!;
    if (/\s/.test(char)) { cursor += 1; continue; }
    if (char === '/' && source[cursor + 1] === '/') {
      cursor = source.indexOf('\n', cursor + 2);
      if (cursor < 0) return source.length;
      continue;
    }
    if (char === '/' && source[cursor + 1] === '*') {
      const end = source.indexOf('*/', cursor + 2);
      cursor = end < 0 ? source.length : end + 2;
      continue;
    }
    if (char === '/' && canStartRegex()) {
      cursor = skipRegex(source, cursor);
      previous = 'literal';
      continue;
    }
    if (char === '\'' || char === '"') {
      const quoted = readQuoted(source, cursor, char);
      literals.push(quoted.value);
      cursor = quoted.end;
      previous = 'literal';
      continue;
    }
    if (char === '`') {
      const template = scanTemplate(source, cursor, literals);
      literals.push(template.value);
      cursor = template.end;
      previous = 'literal';
      continue;
    }
    if (stopAtTemplateBrace && char === '}') {
      if (braceDepth === 0) return cursor + 1;
      braceDepth -= 1;
      cursor += 1;
      previous = '}';
      continue;
    }
    if (stopAtTemplateBrace && char === '{') {
      braceDepth += 1;
      cursor += 1;
      previous = '{';
      continue;
    }
    if (/[A-Za-z_$]/.test(char)) {
      const startWord = cursor;
      cursor += 1;
      while (cursor < source.length && /[A-Za-z0-9_$]/.test(source[cursor]!)) cursor += 1;
      previous = source.slice(startWord, cursor);
      continue;
    }
    const paired = char === '=' && source[cursor + 1] === '>' ? '=>' : char;
    previous = paired;
    cursor += paired.length;
  }
  return cursor;
}

function scanTemplate(source: string, start: number, literals: string[]): { value: string; end: number } {
  let cursor = start + 1;
  let value = '';
  while (cursor < source.length) {
    const char = source[cursor]!;
    if (char === '`') return { value, end: cursor + 1 };
    if (char === '\\') {
      value += decodeEscape(source[cursor + 1] ?? '');
      cursor += 2;
      continue;
    }
    if (char === '$' && source[cursor + 1] === '{') {
      value += templateTable;
      cursor = scanCode(source, cursor + 2, true, literals);
      continue;
    }
    value += char;
    cursor += 1;
  }
  return { value, end: cursor };
}

function stringLiterals(source: string): string[] {
  const literals: string[] = [];
  scanCode(source, 0, false, literals);
  return literals;
}

function skipSqlTrivia(sql: string, start: number): number {
  let cursor = start;
  while (cursor < sql.length) {
    if (/\s/.test(sql[cursor]!)) { cursor += 1; continue; }
    if (sql.startsWith('--', cursor)) {
      const end = sql.indexOf('\n', cursor + 2);
      cursor = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (sql.startsWith('/*', cursor)) {
      const end = sql.indexOf('*/', cursor + 2);
      cursor = end < 0 ? sql.length : end + 2;
      continue;
    }
    break;
  }
  return cursor;
}

function sqlIdentifier(sql: string, start: number): { value: string; end: number } | undefined {
  if (sql.startsWith(templateTable, start)) return { value: templateTable, end: start + templateTable.length };
  if (sql[start] === '"') {
    const end = sql.indexOf('"', start + 1);
    return end < 0 ? undefined : { value: sql.slice(start + 1, end).replaceAll('""', '"'), end: end + 1 };
  }
  const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(sql.slice(start));
  return match ? { value: match[0], end: start + match[0].length } : undefined;
}

function sqlWord(sql: string, start: number, word: string): number | undefined {
  const cursor = skipSqlTrivia(sql, start);
  const match = new RegExp(`^${word}\\b`, 'i').exec(sql.slice(cursor));
  return match ? cursor + match[0].length : undefined;
}

function qualifiedTarget(sql: string, start: number): { table: AccessFixtureWriteTable; end: number } | undefined {
  const schema = sqlIdentifier(sql, start);
  if (!schema || schema.value.toLowerCase() !== 'access') return undefined;
  let cursor = skipSqlTrivia(sql, schema.end);
  if (sql[cursor] !== '.') return undefined;
  cursor = skipSqlTrivia(sql, cursor + 1);
  const name = sqlIdentifier(sql, cursor);
  if (!name) return undefined;
  const normalized = name.value.toLowerCase();
  if (tableNameSet.has(normalized)) {
    return { table: `access.${normalized as (typeof tableNames)[number]}`, end: name.end };
  }
  if (name.value === templateTable) return { table: 'access.<template table>', end: name.end };
  return undefined;
}

function copyHasFrom(sql: string, start: number): boolean {
  let cursor = skipSqlTrivia(sql, start);
  if (sql[cursor] === '(') {
    let depth = 0;
    do {
      if (sql[cursor] === '(') depth += 1;
      else if (sql[cursor] === ')') depth -= 1;
      cursor += 1;
    } while (cursor < sql.length && depth > 0);
  }
  return sqlWord(sql, cursor, 'from') !== undefined;
}

function writesInLiteral(sql: string): AccessFixtureWriteTable[] {
  const writes: AccessFixtureWriteTable[] = [];
  const action = /\b(insert\s+into|delete\s+from|update|truncate|copy)\b/gi;
  for (let match = action.exec(sql); match; match = action.exec(sql)) {
    const kind = match[1]!.toLowerCase().split(/\s+/)[0]!;
    let cursor = skipSqlTrivia(sql, action.lastIndex);
    if (kind === 'truncate') cursor = sqlWord(sql, cursor, 'table') ?? cursor;
    if (kind === 'insert' || kind === 'delete' || kind === 'update' || kind === 'truncate') {
      cursor = sqlWord(sql, cursor, 'only') ?? cursor;
    }
    cursor = skipSqlTrivia(sql, cursor);
    while (true) {
      const target = qualifiedTarget(sql, cursor);
      if (target && (kind !== 'copy' || copyHasFrom(sql, target.end))) writes.push(target.table);
      if (kind !== 'truncate' || !target) break;
      cursor = skipSqlTrivia(sql, target.end);
      if (sql[cursor] !== ',') break;
      cursor = skipSqlTrivia(sql, cursor + 1);
    }
  }
  return writes;
}

export function scanAccessFixtureWriteText(source: string, file = '<source>'): AccessFixtureWrite[] {
  const writes = new Set<AccessFixtureWriteTable>();
  for (const literal of stringLiterals(source)) {
    for (const table of writesInLiteral(literal)) writes.add(table);
  }
  return [...writes].map(table => ({ file, table })).sort((a, b) => a.table.localeCompare(b.table));
}

function isExcluded(file: string): boolean {
  const normalized = file.split(sep).join('/');
  if (normalized.startsWith('services/main/src/modules/access/')) return true;
  if (/(^|\/)migrations?(\/|$)/i.test(normalized)) return true;
  return false;
}

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (directory: string) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (sourceExtensions.has(extname(name)) && !isExcluded(relative(root, path))) files.push(path);
    }
  };
  for (const directory of sourceRoots) {
    const path = join(root, directory);
    try { walk(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return files.sort();
}

export function scanAccessFixtureWrites(root = resolve(import.meta.dir, '../..')): AccessFixtureWrite[] {
  const findings = sourceFiles(root).flatMap(path =>
    scanAccessFixtureWriteText(readFileSync(path, 'utf8'), relative(root, path).split(sep).join('/')));
  const unique = new Map(findings.map(item => [`${item.file}\0${item.table}`, item]));
  return [...unique.values()].sort((a, b) => a.file.localeCompare(b.file) || a.table.localeCompare(b.table));
}

export function accessFixtureWriteDebtFiles(findings: readonly AccessFixtureWrite[]): string[] {
  return [...new Set(findings.map(item => item.file))].sort();
}

export function staleAccessFixtureWriteDebt(findings: readonly AccessFixtureWrite[], debt: readonly string[]): string[] {
  const current = new Set(accessFixtureWriteDebtFiles(findings));
  return [...new Set(debt)].filter(file => !current.has(file)).sort();
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, '../..');
  const findings = scanAccessFixtureWrites(root);
  const debtPath = resolve(import.meta.dir, 'access-fixture-writes-debt.json');
  if (process.argv.includes('--write-debt')) {
    writeFileSync(debtPath, `${JSON.stringify(accessFixtureWriteDebtFiles(findings), null, 2)}\n`);
    console.log(`Wrote ${accessFixtureWriteDebtFiles(findings).length} debt file(s) to ${relative(root, debtPath)}`);
  } else {
    for (const finding of findings) console.log(`${finding.file}: ${finding.table}`);
    console.log(`Found ${findings.length} access fixture write(s) in ${accessFixtureWriteDebtFiles(findings).length} file(s)`);
  }
}
