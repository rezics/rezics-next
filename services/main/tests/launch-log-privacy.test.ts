import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const modulesRoot = fileURLToPath(new URL('../src/modules/', import.meta.url));

/** These directory names are the launch modules whose operational logs stay free of row values. */
const prefixed = /^(?:library|progress|realm|zone|notification)/;
const exact = new Set(['reading-position', 'space', 'presentation', 'theme', 'saved-filter', 'follows']);
const regexAfter = new Set([
  'return', 'throw', 'case', 'else', 'do', 'typeof', 'void', 'delete', 'await', 'yield', 'new',
  'in', 'of', 'instanceof', 'extends',
]);

type Frame =
  | { kind: 'code'; braces: number }
  | { kind: 'template' }
  | { kind: 'string'; quote: "'" | '"' }
  | { kind: 'line' }
  | { kind: 'block' };

function isIdentStart(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z_$]/.test(char);
}
function isIdentPart(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9_$]/.test(char);
}
function boundary(source: string, index: number): boolean {
  if (index === 0) return true;
  return !/[A-Za-z0-9_$.]/.test(source[index - 1]!);
}

/** A `/…/` literal, or -1 when the slash is division. Stops at a newline so a failed guess cannot swallow the next line. */
function consumeRegex(source: string, start: number): number {
  let index = start + 1;
  let klass = false;
  while (index < source.length) {
    const char = source[index]!;
    if (char === '\n') return -1;
    if (char === '\\') { index += 2; continue; }
    if (char === '[') klass = true;
    else if (char === ']' && klass) klass = false;
    else if (char === '/' && !klass) {
      index++;
      while (index < source.length && /[A-Za-z]/.test(source[index]!)) index++;
      return index;
    }
    index++;
  }
  return -1;
}

function skipTrivia(source: string, index: number): number {
  let cursor = index;
  while (cursor < source.length) {
    const char = source[cursor]!;
    const next = source[cursor + 1];
    if (/\s/.test(char)) { cursor++; continue; }
    if (char === '/' && next === '/') {
      cursor += 2;
      while (cursor < source.length && source[cursor] !== '\n') cursor++;
      continue;
    }
    if (char === '/' && next === '*') {
      cursor += 2;
      while (cursor < source.length && !(source[cursor] === '*' && source[cursor + 1] === '/')) cursor++;
      cursor = Math.min(source.length, cursor + 2);
      continue;
    }
    break;
  }
  return cursor;
}

/** `console.method(` or `console['method'](`, including optional calls. The index is the opening parenthesis. */
function lookCall(source: string, index: number): { method: string; paren: number } | undefined {
  let cursor = skipTrivia(source, index);
  if (source[cursor] === '?' && source[cursor + 1] === '.') cursor = skipTrivia(source, cursor + 2);
  let method = '';
  if (source[cursor] === '.') {
    cursor = skipTrivia(source, cursor + 1);
    if (!isIdentStart(source[cursor])) return;
    const start = cursor;
    cursor++;
    while (isIdentPart(source[cursor])) cursor++;
    method = source.slice(start, cursor);
  } else if (source[cursor] === '[') {
    cursor = skipTrivia(source, cursor + 1);
    const quote = source[cursor];
    if (quote !== "'" && quote !== '"') return;
    const end = endQuoted(source, cursor);
    if (end < 0 || source[end] !== quote) return;
    method = source.slice(cursor + 1, end);
    cursor = skipTrivia(source, end + 1);
    if (source[cursor] !== ']') return;
    cursor = skipTrivia(source, cursor + 1);
  } else return;
  if (source[cursor] === '?' && source[cursor + 1] === '.') cursor = skipTrivia(source, cursor + 2);
  if (source[cursor] !== '(') return;
  return { method, paren: cursor };
}

function endQuoted(source: string, start: number): number {
  const quote = source[start];
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === '\\') { index += 2; continue; }
    if (source[index] === quote) return index;
    if (source[index] === '\n') return -1;
    index++;
  }
  return -1;
}

/** No-substitution template, or -1 when it interpolates or never closes. */
function endPlainTemplate(source: string, start: number): number {
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === '\\') { index += 2; continue; }
    if (source[index] === '$' && source[index + 1] === '{') return -1;
    if (source[index] === '`') return index;
    index++;
  }
  return -1;
}

function removeComments(source: string): string {
  let out = '';
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    const next = source[index + 1];
    if (char === "'" || char === '"') {
      const end = endQuoted(source, index);
      if (end < 0) { out += source.slice(index); break; }
      out += source.slice(index, end + 1);
      index = end + 1;
      continue;
    }
    if (char === '`') {
      const end = endPlainTemplate(source, index);
      if (end < 0) { out += source.slice(index); break; }
      out += source.slice(index, end + 1);
      index = end + 1;
      continue;
    }
    if (char === '/' && next === '/') {
      index += 2;
      while (index < source.length && source[index] !== '\n') index++;
      out += ' ';
      continue;
    }
    if (char === '/' && next === '*') {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index++;
      index = Math.min(source.length, index + 2);
      out += ' ';
      continue;
    }
    out += char;
    index++;
  }
  return out;
}

function matchingParen(source: string, open: number): number {
  let depth = 0;
  let index = open;
  while (index < source.length) {
    const char = source[index]!;
    const next = source[index + 1];
    if (char === "'" || char === '"') {
      const end = endQuoted(source, index);
      if (end < 0) return -1;
      index = end + 1;
      continue;
    }
    if (char === '`') {
      let cursor = index + 1;
      while (cursor < source.length) {
        if (source[cursor] === '\\') { cursor += 2; continue; }
        if (source[cursor] === '`') { cursor++; break; }
        if (source[cursor] === '$' && source[cursor + 1] === '{') {
          const close = matchingBrace(source, cursor + 1);
          if (close < 0) return -1;
          cursor = close + 1;
          continue;
        }
        cursor++;
      }
      index = cursor;
      continue;
    }
    if (char === '/' && next === '/') { while (index < source.length && source[index] !== '\n') index++; continue; }
    if (char === '/' && next === '*') {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index++;
      index += 2;
      continue;
    }
    if (char === '(') depth++;
    else if (char === ')') {
      depth--;
      if (depth === 0) return index;
    }
    index++;
  }
  return -1;
}

function matchingBrace(source: string, open: number): number {
  let depth = 0;
  let index = open;
  while (index < source.length) {
    if (source[index] === '{') depth++;
    else if (source[index] === '}') {
      depth--;
      if (depth === 0) return index;
    }
    index++;
  }
  return -1;
}

/** A console argument may be a string literal or a logWorkerFault call, and nothing else. */
function argumentAllowed(raw: string): boolean {
  const code = removeComments(raw).trim();
  if (!code) return true;
  if (code[0] === "'" || code[0] === '"') return endQuoted(code, 0) === code.length - 1;
  if (code[0] === '`') return endPlainTemplate(code, 0) === code.length - 1;
  const fault = /^logWorkerFault\b/.exec(code);
  if (!fault) return false;
  let index = fault[0].length;
  while (index < code.length && /\s/.test(code[index]!)) index++;
  if (index >= code.length) return true;
  if (code[index] !== '(') return false;
  return matchingParen(code, index) === code.length - 1;
}

function argumentsAllowed(source: string): boolean {
  const parts: string[] = [];
  let start = 0;
  let index = 0;
  let paren = 0;
  let brace = 0;
  let bracket = 0;
  let afterValue = false;
  const frames: Frame[] = [{ kind: 'code', braces: 0 }];
  const mode = () => frames[frames.length - 1]!;
  const push = (at: number) => { parts.push(source.slice(start, at)); start = at + 1; };
  while (index < source.length) {
    const char = source[index]!;
    const next = source[index + 1];
    const frame = mode();
    if (frame.kind === 'line') {
      if (char === '\n') frames.pop();
      index++;
      continue;
    }
    if (frame.kind === 'block') {
      if (char === '*' && next === '/') { frames.pop(); index += 2; continue; }
      index++;
      continue;
    }
    if (frame.kind === 'string') {
      if (char === '\\') { index += 2; continue; }
      index++;
      if (char === frame.quote) { frames.pop(); afterValue = true; }
      continue;
    }
    if (frame.kind === 'template') {
      if (char === '\\') { index += 2; continue; }
      if (char === '`') { frames.pop(); afterValue = true; index++; continue; }
      if (char === '$' && next === '{') { frames.push({ kind: 'code', braces: 0 }); index += 2; continue; }
      index++;
      continue;
    }
    if (char === '/' && next === '/') { frames.push({ kind: 'line' }); index += 2; continue; }
    if (char === '/' && next === '*') { frames.push({ kind: 'block' }); index += 2; continue; }
    if (char === '/' && !afterValue) {
      const end = consumeRegex(source, index);
      if (end > index) { index = end; afterValue = true; continue; }
    }
    if (char === "'" || char === '"') { frames.push({ kind: 'string', quote: char }); index++; continue; }
    if (char === '`') { frames.push({ kind: 'template' }); index++; continue; }
    if (char === '(') { paren++; afterValue = false; index++; continue; }
    if (char === ')') { paren--; afterValue = true; index++; continue; }
    if (char === '[') { bracket++; afterValue = false; index++; continue; }
    if (char === ']') { bracket--; afterValue = true; index++; continue; }
    if (char === '{') { brace++; frame.braces++; afterValue = false; index++; continue; }
    if (char === '}') {
      if (frame.braces > 0) frame.braces--;
      else if (frames.length > 1) frames.pop();
      brace--;
      afterValue = false;
      index++;
      continue;
    }
    if (paren === 0 && brace <= 0 && bracket === 0 && char === ',') { push(index); afterValue = false; index++; continue; }
    if (isIdentStart(char)) {
      const wordStart = index;
      index++;
      while (isIdentPart(source[index])) index++;
      afterValue = !regexAfter.has(source.slice(wordStart, index));
      continue;
    }
    if (char >= '0' && char <= '9') {
      index++;
      while (index < source.length && /[0-9A-Za-z_.]/.test(source[index]!)) index++;
      afterValue = true;
      continue;
    }
    if (!/\s/.test(char)) {
      if ((char === '+' && next === '+') || (char === '-' && next === '-')) { index += 2; continue; }
      afterValue = false;
    }
    index++;
  }
  parts.push(source.slice(start));
  return parts.every(argumentAllowed);
}

/** Console calls whose arguments are not string literals or `logWorkerFault`, named with file and line. */
export function consoleValueLeaks(source: string, file: string): string[] {
  const leaks: string[] = [];
  const frames: Frame[] = [{ kind: 'code', braces: 0 }];
  const calls: { line: number; method: string; argStart: number; openAt: number }[] = [];
  let index = 0;
  let line = 1;
  let paren = 0;
  let afterValue = false;
  const mode = () => frames[frames.length - 1]!;
  while (index < source.length) {
    const char = source[index]!;
    const next = source[index + 1];
    const frame = mode();
    if (frame.kind === 'line') {
      if (char === '\n') { line++; frames.pop(); }
      index++;
      continue;
    }
    if (frame.kind === 'block') {
      if (char === '*' && next === '/') { index += 2; continue; }
      if (char === '\n') line++;
      index++;
      continue;
    }
    if (frame.kind === 'string') {
      if (char === '\\') { if (next === '\n') line++; index += 2; continue; }
      if (char === '\n') line++;
      index++;
      if (char === frame.quote) { frames.pop(); afterValue = true; }
      continue;
    }
    if (frame.kind === 'template') {
      if (char === '\\') { if (next === '\n') line++; index += 2; continue; }
      if (char === '`') { frames.pop(); afterValue = true; index++; continue; }
      if (char === '$' && next === '{') { frames.push({ kind: 'code', braces: 0 }); index += 2; afterValue = false; continue; }
      if (char === '\n') line++;
      index++;
      continue;
    }
    if (char === '/' && next === '/') { frames.push({ kind: 'line' }); index += 2; continue; }
    if (char === '/' && next === '*') { frames.push({ kind: 'block' }); index += 2; continue; }
    if (char === '/' && !afterValue) {
      const end = consumeRegex(source, index);
      if (end > index) { index = end; afterValue = true; continue; }
    }
    if (char === "'" || char === '"') { frames.push({ kind: 'string', quote: char }); index++; continue; }
    if (char === '`') { frames.push({ kind: 'template' }); index++; continue; }
    if (char === '{') { frame.braces++; afterValue = false; index++; continue; }
    if (char === '}') {
      if (frame.braces > 0) frame.braces--;
      else if (frames.length > 1) frames.pop();
      afterValue = false;
      index++;
      continue;
    }
    if (char === '(') { paren++; afterValue = false; index++; continue; }
    if (char === ')') {
      paren--;
      const call = calls.at(-1);
      if (call && call.openAt === paren) {
        calls.pop();
        if (!argumentsAllowed(source.slice(call.argStart, index))) {
          leaks.push(`${file}:${call.line} console.${call.method}(...)`);
        }
      }
      afterValue = true;
      index++;
      continue;
    }
    if (char === '[') { afterValue = false; index++; continue; }
    if (char === ']') { afterValue = true; index++; continue; }
    if (isIdentStart(char)) {
      const start = index;
      const startLine = line;
      index++;
      while (isIdentPart(source[index])) index++;
      const word = source.slice(start, index);
      if (word === 'console' && boundary(source, start)) {
        const looked = lookCall(source, index);
        // openAt is the depth outside this call, so a nested call's parenthesis does not close it.
        if (looked) calls.push({ line: startLine, method: looked.method, argStart: looked.paren + 1, openAt: paren });
      }
      afterValue = !regexAfter.has(word);
      continue;
    }
    if (char >= '0' && char <= '9') {
      index++;
      while (index < source.length && /[0-9A-Za-z_.]/.test(source[index]!)) index++;
      afterValue = true;
      continue;
    }
    if (char === '\n') line++;
    if (!/\s/.test(char)) {
      if ((char === '+' && next === '+') || (char === '-' && next === '-')) { index += 2; continue; }
      afterValue = false;
    }
    index++;
  }
  return leaks;
}

function launchModuleFiles(): string[] {
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) files.push(path);
    }
  };
  for (const entry of readdirSync(modulesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!prefixed.test(entry.name) && !exact.has(entry.name)) continue;
    visit(join(modulesRoot, entry.name));
  }
  return files.sort();
}

test('a console call that passes a value is reported with its file and line', () => {
  const source = [
    'console.error("fixed");',
    'console.warn(`also fixed`);',
    'logWorkerFault("main.library.follow", error);',
    'console.error(logWorkerFault("main.library.follow", error));',
    'console.error("Safety alerts:", error);',
    '// console.error("hidden", error)',
    'const text = "console.error(\'hidden\', error)";',
    'const id = /^https:\\/\\/rezics\\.com\\/id\\/[0-9a-f-]{36}$/;',
    "const quoted = /^='\"?$/;",
    'let value = raw.replace(/^="?/, "").replace(/"$/, "");',
    'console.error("still fixed");',
    'const line = `kept ${console.warn("bad", error)}`;',
    'console.error(',
    '  "multi",',
    '  error,',
    ');',
  ].join('\n');
  expect(consoleValueLeaks(source, 'sample.ts')).toEqual([
    'sample.ts:5 console.error(...)',
    'sample.ts:12 console.warn(...)',
    'sample.ts:13 console.error(...)',
  ]);
});

test('launch module console calls pass only string literals or logWorkerFault', () => {
  const leaks = launchModuleFiles().flatMap(file =>
    consoleValueLeaks(readFileSync(file, 'utf8'), relative(repoRoot, file)));
  expect(leaks).toEqual([]);
});
