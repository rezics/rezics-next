/** Assignment names whose values are credentials in command text. */
const SECRET_NAME = /^[A-Z][A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN|KEY)$/;

type Ansi = { kind: 'sequence'; end: number } | { kind: 'incomplete' } | { kind: 'no' };

/**
 * ECMA-48 escapes are not part of a name or a value. An incomplete introducer
 * at the end of a chunk must be held: the final byte can be a word character
 * glued to the next chunk's assignment.
 */
function lookAnsi(text: string, index: number): Ansi {
  if (text.charCodeAt(index) !== 0x1b) return { kind: 'no' };
  if (index + 1 >= text.length) return { kind: 'incomplete' };
  const next = text.charCodeAt(index + 1)!;
  if (next === 0x5b) {
    let cursor = index + 2;
    while (cursor < text.length) {
      const code = text.charCodeAt(cursor);
      if (code >= 0x40 && code <= 0x7e) return { kind: 'sequence', end: cursor + 1 };
      if (code >= 0x20 && code <= 0x3f) {
        cursor++;
        continue;
      }
      return { kind: 'no' };
    }
    return { kind: 'incomplete' };
  }
  if (next === 0x5d) {
    let cursor = index + 2;
    while (cursor < text.length) {
      const code = text.charCodeAt(cursor);
      if (code === 0x07) return { kind: 'sequence', end: cursor + 1 };
      if (code === 0x1b) {
        if (cursor + 1 >= text.length) return { kind: 'incomplete' };
        if (text.charCodeAt(cursor + 1) === 0x5c) return { kind: 'sequence', end: cursor + 2 };
        return { kind: 'no' };
      }
      cursor++;
    }
    return { kind: 'incomplete' };
  }
  if (next >= 0x40 && next <= 0x5f) return { kind: 'sequence', end: index + 2 };
  return { kind: 'no' };
}

function isNameStart(code: number): boolean {
  return code >= 65 && code <= 90;
}

function isNameChar(code: number): boolean {
  return isNameStart(code) || (code >= 48 && code <= 57) || code === 95;
}

function isSpace(char: string): boolean {
  return /\s/u.test(char);
}

type Scan =
  | { kind: 'emit'; end: number }
  | { kind: 'hold' }
  | { kind: 'secret'; replacement: string; valueEnd: number; open: boolean };

type ValueRead = { kind: 'hold' } | { kind: 'none' } | { kind: 'value'; end: number; open: boolean };

/** A credential runs until whitespace or a color sequence. The sequence stays. */
function readValue(text: string, start: number, flush: boolean): ValueRead {
  let valueEnd = start;
  if (valueEnd >= text.length || isSpace(text[valueEnd]!)) return { kind: 'none' };
  while (valueEnd < text.length) {
    if (isSpace(text[valueEnd]!)) break;
    if (text.charCodeAt(valueEnd) === 0x1b) {
      const looked = lookAnsi(text, valueEnd);
      if (looked.kind === 'incomplete') {
        if (valueEnd === start) return flush ? { kind: 'none' } : { kind: 'hold' };
        return { kind: 'value', end: valueEnd, open: !flush };
      }
      if (looked.kind === 'sequence') break;
    }
    valueEnd++;
  }
  if (valueEnd === start) return { kind: 'none' };
  if (valueEnd === text.length && !flush) return { kind: 'value', end: valueEnd, open: true };
  return { kind: 'value', end: valueEnd, open: false };
}

function isWord(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
}

function skipGap(
  text: string,
  index: number,
  flush: boolean,
  spaces = true,
): { index: number; ansi: string } | 'hold' {
  let ansi = '';
  let cursor = index;
  while (cursor < text.length) {
    if (spaces && isSpace(text[cursor]!)) {
      cursor++;
      continue;
    }
    if (text.charCodeAt(cursor) !== 0x1b) return { index: cursor, ansi };
    const looked = lookAnsi(text, cursor);
    if (looked.kind === 'sequence') {
      ansi += text.slice(cursor, looked.end);
      cursor = looked.end;
      continue;
    }
    if (looked.kind === 'incomplete') return flush ? { index: cursor, ansi } : 'hold';
    return { index: cursor, ansi };
  }
  return flush ? { index: cursor, ansi } : 'hold';
}

function scanAssignment(text: string, index: number, flush: boolean): Scan {
  if (!isNameStart(text.charCodeAt(index))) return { kind: 'emit', end: index + 1 };
  let nameEnd = index + 1;
  while (nameEnd < text.length && isNameChar(text.charCodeAt(nameEnd))) nameEnd++;
  if (nameEnd === text.length && !flush) return { kind: 'hold' };
  const name = text.slice(index, nameEnd);
  if (!SECRET_NAME.test(name)) return { kind: 'emit', end: nameEnd };

  const beforeEquals = skipGap(text, nameEnd, flush);
  if (beforeEquals === 'hold') return { kind: 'hold' };
  if (beforeEquals.index >= text.length || text[beforeEquals.index] !== '=')
    return { kind: 'emit', end: nameEnd };

  const afterEquals = skipGap(text, beforeEquals.index + 1, flush);
  if (afterEquals === 'hold') return { kind: 'hold' };
  const preservedAnsi = beforeEquals.ansi + afterEquals.ansi;
  const value = readValue(text, afterEquals.index, flush);
  if (value.kind === 'hold') return { kind: 'hold' };
  if (value.kind === 'none') return { kind: 'emit', end: nameEnd };
  // The value can continue in the next read. Drop it once the assignment is known
  // so a tail window cannot retain the credential.
  return {
    kind: 'secret',
    replacement: `${name}=[redacted]${preservedAnsi}`,
    valueEnd: value.end,
    open: value.open,
  };
}

const DATABASE_SCHEMES = ['postgresql://', 'postgres://'] as const;

function schemeRelation(text: string, index: number, scheme: string): 'match' | 'prefix' | 'no' {
  const available = text.length - index;
  const limit = Math.min(available, scheme.length);
  for (let i = 0; i < limit; i++) {
    const code = text.charCodeAt(index + i)!;
    const folded = code >= 65 && code <= 90 ? code + 32 : code;
    if (folded !== scheme.charCodeAt(i)) return 'no';
  }
  return available >= scheme.length ? 'match' : 'prefix';
}

function isCandidateStart(code: number): boolean {
  const folded = code >= 65 && code <= 90 ? code + 32 : code;
  return folded === 112 || folded === 98;
}

function finishDatabase(text: string, schemeEnd: number, flush: boolean): Scan {
  const gap = skipGap(text, schemeEnd, flush, false);
  if (gap === 'hold') return { kind: 'hold' };
  const value = readValue(text, gap.index, flush);
  if (value.kind === 'hold') return { kind: 'hold' };
  if (value.kind === 'none') return { kind: 'emit', end: schemeEnd };
  return { kind: 'secret', replacement: `[database]${gap.ansi}`, valueEnd: value.end, open: value.open };
}

/** A word boundary ignores color. `m` from a preceding SGR sequence is not a letter. */
function scanDatabase(text: string, index: number, flush: boolean, wordEdge: boolean): Scan | null {
  if (!wordEdge) return null;
  let prefix = false;
  for (const scheme of DATABASE_SCHEMES) {
    const relation = schemeRelation(text, index, scheme);
    if (relation === 'match') return finishDatabase(text, index + scheme.length, flush);
    if (relation === 'prefix') prefix = true;
  }
  if (!prefix) return null;
  return flush ? { kind: 'emit', end: index + 1 } : { kind: 'hold' };
}

function scanBearer(text: string, index: number, flush: boolean, wordEdge: boolean): Scan | null {
  if (!wordEdge) return null;
  const relation = schemeRelation(text, index, 'bearer');
  if (relation === 'prefix') return flush ? { kind: 'emit', end: index + 1 } : { kind: 'hold' };
  if (relation !== 'match') return null;
  const after = index + 'bearer'.length;
  if (after < text.length && isWord(text.charCodeAt(after)!)) return null;
  const lead = skipGap(text, after, flush, false);
  if (lead === 'hold') return { kind: 'hold' };
  if (lead.index >= text.length || !isSpace(text[lead.index]!)) {
    return lead.index >= text.length && !flush ? { kind: 'hold' } : { kind: 'emit', end: after };
  }
  const gap = skipGap(text, lead.index, flush, true);
  if (gap === 'hold') return { kind: 'hold' };
  const value = readValue(text, gap.index, flush);
  if (value.kind === 'hold') return { kind: 'hold' };
  if (value.kind === 'none') return gap.index >= text.length && !flush ? { kind: 'hold' } : { kind: 'emit', end: after };
  return {
    kind: 'secret',
    replacement: `Bearer [token]${lead.ansi}${gap.ansi}`,
    valueEnd: value.end,
    open: value.open,
  };
}

function scanGovernance(text: string, index: number, flush: boolean, wordEdge: boolean): Scan {
  if (wordEdge) {
    const database = scanDatabase(text, index, flush, wordEdge);
    if (database) return database;
    const bearer = scanBearer(text, index, flush, wordEdge);
    if (bearer) return bearer;
  }
  let end = index + 1;
  while (end < text.length && text.charCodeAt(end) !== 0x1b) {
    if (isCandidateStart(text.charCodeAt(end)!) && !isWord(text.charCodeAt(end - 1)!)) break;
    end++;
  }
  return { kind: 'emit', end };
}

function edgeAfter(text: string, edge: boolean): boolean {
  let current = edge;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 0x1b) {
      const looked = lookAnsi(text, i);
      if (looked.kind === 'sequence') {
        i = looked.end - 1;
        continue;
      }
    }
    current = !isWord(text.charCodeAt(i)!);
  }
  return current;
}

function drain(
  buffer: string,
  flush: boolean,
  swallowing: boolean,
  governance: boolean,
  wordEdge: boolean,
): { emitted: string; rest: string; swallowing: boolean; wordEdge: boolean } {
  let emitted = '';
  let index = 0;
  if (swallowing) {
    while (index < buffer.length) {
      if (isSpace(buffer[index]!)) {
        swallowing = false;
        break;
      }
      if (buffer.charCodeAt(index) === 0x1b) {
        const looked = lookAnsi(buffer, index);
        if (looked.kind === 'sequence') {
          swallowing = false;
          break;
        }
        if (looked.kind === 'incomplete') {
          if (!flush) return { emitted, rest: buffer.slice(index), swallowing: true, wordEdge };
          swallowing = false;
          break;
        }
      }
      index++;
    }
  }
  while (index < buffer.length) {
    if (buffer.charCodeAt(index) === 0x1b) {
      const looked = lookAnsi(buffer, index);
      if (looked.kind === 'sequence') {
        emitted += buffer.slice(index, looked.end);
        index = looked.end;
        continue;
      }
      if (looked.kind === 'incomplete' && !flush) break;
    }
    const scanned = governance
      ? scanGovernance(buffer, index, flush, wordEdge)
      : scanAssignment(buffer, index, flush);
    if (scanned.kind === 'hold') break;
    if (scanned.kind === 'emit') {
      const slice = buffer.slice(index, scanned.end);
      emitted += slice;
      wordEdge = edgeAfter(slice, wordEdge);
      index = scanned.end;
      continue;
    }
    emitted += scanned.replacement;
    wordEdge = edgeAfter(scanned.replacement, wordEdge);
    index = scanned.valueEnd;
    if (scanned.open) {
      swallowing = true;
      break;
    }
  }
  return { emitted, rest: buffer.slice(index), swallowing, wordEdge };
}

type OutputRedactor = { push(chunk: string): string; finish(): string };

function createRedactor(governance: boolean): OutputRedactor {
  let pending = '';
  let swallowing = false;
  let wordEdge = true;
  return {
    push(chunk: string) {
      pending += chunk;
      const drained = drain(pending, false, swallowing, governance, wordEdge);
      pending = drained.rest;
      swallowing = drained.swallowing;
      wordEdge = drained.wordEdge;
      return drained.emitted;
    },
    finish() {
      const drained = drain(pending, true, swallowing, governance, wordEdge);
      pending = drained.rest;
      swallowing = false;
      wordEdge = drained.wordEdge;
      return drained.emitted + drained.rest;
    },
  };
}

/** Incremental redaction. A name or value may be split across reads. */
export function createCommandOutputRedactor(): OutputRedactor {
  return createRedactor(false);
}

/** Postgres URLs and bearer tokens, with the same color and chunk rules as assignments. */
export function createGovernanceOutputRedactor(): OutputRedactor {
  return createRedactor(true);
}

/** Replace credential assignment values. Surrounding text, including color, stays. */
export function redactCommandOutput(text: string): string {
  const redactor = createCommandOutputRedactor();
  return redactor.push(text) + redactor.finish();
}
