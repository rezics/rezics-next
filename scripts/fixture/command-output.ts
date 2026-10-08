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
  | { kind: 'secret'; nameEnd: number; valueEnd: number; preservedAnsi: string; open: boolean };

function skipGap(
  text: string,
  index: number,
  flush: boolean,
): { index: number; ansi: string } | 'hold' {
  let ansi = '';
  let cursor = index;
  while (cursor < text.length) {
    if (isSpace(text[cursor]!)) {
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
  let valueEnd = afterEquals.index;
  if (valueEnd >= text.length || isSpace(text[valueEnd]!)) return { kind: 'emit', end: nameEnd };
  while (valueEnd < text.length) {
    if (isSpace(text[valueEnd]!)) break;
    if (text.charCodeAt(valueEnd) === 0x1b) {
      const looked = lookAnsi(text, valueEnd);
      if (looked.kind === 'incomplete') {
        // No value byte yet: an unfinished color sequence is not a credential.
        if (valueEnd === afterEquals.index) return flush ? { kind: 'emit', end: nameEnd } : { kind: 'hold' };
        return { kind: 'secret', nameEnd, valueEnd, preservedAnsi, open: !flush };
      }
      if (looked.kind === 'sequence') break;
    }
    valueEnd++;
  }
  if (valueEnd === afterEquals.index) return { kind: 'emit', end: nameEnd };
  // The value can continue in the next read. Drop it once the assignment is known
  // so a tail window cannot retain the credential.
  if (valueEnd === text.length && !flush) return { kind: 'secret', nameEnd, valueEnd, preservedAnsi, open: true };
  return { kind: 'secret', nameEnd, valueEnd, preservedAnsi, open: false };
}

function drain(
  buffer: string,
  flush: boolean,
  swallowing: boolean,
): { emitted: string; rest: string; swallowing: boolean } {
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
          if (!flush) return { emitted, rest: buffer.slice(index), swallowing: true };
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
    const scanned = scanAssignment(buffer, index, flush);
    if (scanned.kind === 'hold') break;
    if (scanned.kind === 'emit') {
      emitted += buffer.slice(index, scanned.end);
      index = scanned.end;
      continue;
    }
    emitted += `${buffer.slice(index, scanned.nameEnd)}=[redacted]${scanned.preservedAnsi}`;
    index = scanned.valueEnd;
    if (scanned.open) {
      swallowing = true;
      break;
    }
  }
  return { emitted, rest: buffer.slice(index), swallowing };
}

/** Incremental redaction. A name or value may be split across reads. */
export function createCommandOutputRedactor(): { push(chunk: string): string; finish(): string } {
  let pending = '';
  let swallowing = false;
  return {
    push(chunk: string) {
      pending += chunk;
      const drained = drain(pending, false, swallowing);
      pending = drained.rest;
      swallowing = drained.swallowing;
      return drained.emitted;
    },
    finish() {
      const drained = drain(pending, true, swallowing);
      pending = drained.rest;
      swallowing = false;
      return drained.emitted + drained.rest;
    },
  };
}

/** Replace credential assignment values. Surrounding text, including color, stays. */
export function redactCommandOutput(text: string): string {
  const redactor = createCommandOutputRedactor();
  return redactor.push(text) + redactor.finish();
}
