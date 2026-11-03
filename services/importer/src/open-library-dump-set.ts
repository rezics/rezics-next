import { dirname, isAbsolute, resolve as resolvePath } from 'node:path';
import { DumpInputError, openRegularFile } from './dump-input.ts';
import type { OpenLibraryDumpFamily } from './dumps.ts';

export type { OpenLibraryDumpFamily };

export const OPEN_LIBRARY_DUMP_SET_VERSION = 1;
export const OPEN_LIBRARY_DUMP_SET_MAX_MEMBERS = 64;
export const OPEN_LIBRARY_DUMP_SET_MAX_MANIFEST_BYTES = 65536;
export const OPEN_LIBRARY_DUMP_SET_MAX_PATH_BYTES = 4096;

const FAMILIES: readonly OpenLibraryDumpFamily[] = ['author', 'work', 'edition'];
const URL_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

export type OpenLibraryDumpSetMember = Readonly<{
  index: number;
  family: OpenLibraryDumpFamily;
  path: string;
}>;

export type OpenLibraryDumpSetAdmission = Readonly<{
  version: typeof OPEN_LIBRARY_DUMP_SET_VERSION;
  sourceKind: 'openlibrary';
  manifestPath: string;
  members: readonly OpenLibraryDumpSetMember[];
}>;

export type OpenLibraryDumpSetReservedPaths = Readonly<{
  state?: string;
  accountKey?: string;
}>;

/** Bounded dump-set failure with a safe member index when the member is known. */
export class OpenLibraryDumpSetError extends DumpInputError {
  readonly memberIndex: number | null;
  readonly reason: string;
  constructor(reason: string, memberIndex: number | null = null) {
    super();
    this.name = 'OpenLibraryDumpSetError';
    this.reason = reason;
    this.memberIndex = memberIndex;
  }
}

function fail(reason: string, memberIndex: number | null = null): never {
  throw new OpenLibraryDumpSetError(reason, memberIndex);
}

function skipWs(text: string, index: number): number {
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code !== 32 && code !== 9 && code !== 10 && code !== 13) break;
    index++;
  }
  return index;
}

function parseString(text: string, start: number): { value: string; index: number } {
  if (text[start] !== '"') fail('manifest');
  let index = start + 1;
  let value = '';
  while (index < text.length) {
    const char = text[index]!;
    if (char === '"') return { value, index: index + 1 };
    if (char === '\\') {
      const next = text[++index];
      if (next === undefined) fail('manifest');
      const escapes: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
      if (next === 'u') {
        const hex = text.slice(index + 1, index + 5);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('manifest');
        value += String.fromCharCode(Number.parseInt(hex, 16));
        index += 5;
        continue;
      }
      const escaped = escapes[next];
      if (escaped === undefined) fail('manifest');
      value += escaped;
      index++;
      continue;
    }
    if (char.charCodeAt(0) < 32) fail('manifest');
    value += char;
    index++;
  }
  fail('manifest');
}

function parseNumber(text: string, start: number): { value: number; index: number } {
  const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(start));
  if (!match) fail('manifest');
  const raw = match[0]!;
  const value = Number(raw);
  if (!Number.isFinite(value)) fail('manifest');
  return { value, index: start + raw.length };
}

function parseValue(text: string, start: number): { value: unknown; index: number } {
  const index = skipWs(text, start);
  const char = text[index];
  if (char === '"') {
    const parsed = parseString(text, index);
    return { value: parsed.value, index: parsed.index };
  }
  if (char === '{') return parseObject(text, index);
  if (char === '[') return parseArray(text, index);
  if (char === 't' && text.slice(index, index + 4) === 'true') return { value: true, index: index + 4 };
  if (char === 'f' && text.slice(index, index + 5) === 'false') return { value: false, index: index + 5 };
  if (char === 'n' && text.slice(index, index + 4) === 'null') return { value: null, index: index + 4 };
  if (char === '-' || (char !== undefined && char >= '0' && char <= '9')) return parseNumber(text, index);
  fail('manifest');
}

function parseObject(text: string, start: number): { value: Record<string, unknown>; index: number } {
  let index = start + 1;
  const value: Record<string, unknown> = {};
  const keys = new Set<string>();
  index = skipWs(text, index);
  if (text[index] === '}') return { value, index: index + 1 };
  for (;;) {
    index = skipWs(text, index);
    const parsedKey = parseString(text, index);
    if (keys.has(parsedKey.value)) fail('manifest');
    keys.add(parsedKey.value);
    index = skipWs(text, parsedKey.index);
    if (text[index] !== ':') fail('manifest');
    const parsedValue = parseValue(text, index + 1);
    Object.defineProperty(value, parsedKey.value, {
      value: parsedValue.value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    index = skipWs(text, parsedValue.index);
    if (text[index] === ',') {
      index++;
      continue;
    }
    if (text[index] === '}') return { value, index: index + 1 };
    fail('manifest');
  }
}

function parseArray(text: string, start: number): { value: unknown[]; index: number } {
  let index = start + 1;
  const value: unknown[] = [];
  index = skipWs(text, index);
  if (text[index] === ']') return { value, index: index + 1 };
  for (;;) {
    const parsed = parseValue(text, index);
    value.push(parsed.value);
    index = skipWs(text, parsed.index);
    if (text[index] === ',') {
      index++;
      continue;
    }
    if (text[index] === ']') return { value, index: index + 1 };
    fail('manifest');
  }
}

function parseManifestJson(text: string): Record<string, unknown> {
  const parsed = parseValue(text, 0);
  const index = skipWs(text, parsed.index);
  if (index !== text.length) fail('manifest');
  if (!parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) fail('manifest');
  return parsed.value as Record<string, unknown>;
}

function ownKeys(value: object): string[] {
  return Object.keys(value);
}

function isFamily(value: unknown): value is OpenLibraryDumpFamily {
  return value === 'author' || value === 'work' || value === 'edition';
}

function pathBytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function rejectUrlOrExpansion(path: string): void {
  if (path.includes('\0') || path.includes('\n') || path.includes('\r')) fail('path');
  if (URL_SCHEME.test(path) || path.includes('://')) fail('path');
  if (path.includes('*') || path.includes('?') || path.includes('[') || path.includes(']')) fail('path');
  if (path.startsWith('~') || path.includes('$')) fail('path');
}

function sameResolved(left: string, right: string): boolean {
  return resolvePath(left) === resolvePath(right);
}

async function assertAvailableMember(path: string, index: number): Promise<void> {
  const handles = { value: 0 };
  let handle;
  try {
    handle = await openRegularFile(path, handles);
  } catch (error) {
    if (error instanceof OpenLibraryDumpSetError) throw error;
    fail('unavailable', index);
  }
  try {
    await handle.close();
  } finally {
    handles.value--;
  }
}

/**
 * Admit a version-1 local Open Library dump-set manifest and check every member
 * is an available regular file. Relative member paths resolve from the manifest
 * directory. Admission does not read member bodies or treat path/mtime as identity.
 */
export async function admitOpenLibraryDumpSet(
  manifestPath: string,
  reserved: OpenLibraryDumpSetReservedPaths = {},
  sourceKind: 'openlibrary' = 'openlibrary',
): Promise<OpenLibraryDumpSetAdmission> {
  if (typeof manifestPath !== 'string' || !manifestPath.trim() || manifestPath === '-') fail('manifest');
  rejectUrlOrExpansion(manifestPath);
  if (pathBytes(manifestPath) > OPEN_LIBRARY_DUMP_SET_MAX_PATH_BYTES) fail('manifest');
  const resolvedManifest = resolvePath(manifestPath);
  if (reserved.state && sameResolved(resolvedManifest, reserved.state)) fail('reserved-path');
  if (reserved.accountKey && sameResolved(resolvedManifest, reserved.accountKey)) fail('reserved-path');

  const handles = { value: 0 };
  const handle = await openRegularFile(resolvedManifest, handles);
  let text: string;
  try {
    const identity = await handle.stat();
    if (identity.size <= 0 || identity.size > OPEN_LIBRARY_DUMP_SET_MAX_MANIFEST_BYTES) fail('manifest');
    const buffer = new Uint8Array(OPEN_LIBRARY_DUMP_SET_MAX_MANIFEST_BYTES + 1);
    const read = await handle.read(buffer, 0, buffer.byteLength, 0);
    if (read.bytesRead > OPEN_LIBRARY_DUMP_SET_MAX_MANIFEST_BYTES || (await handle.stat()).size !== identity.size)
      fail('manifest');
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, read.bytesRead));
    } catch {
      fail('manifest');
    }
  } finally {
    try {
      await handle.close();
    } finally {
      handles.value--;
    }
  }

  const document = parseManifestJson(text);
  const keys = ownKeys(document);
  if (keys.length !== 3 || !keys.includes('version') || !keys.includes('source') || !keys.includes('members'))
    fail('manifest');
  if (document.version !== OPEN_LIBRARY_DUMP_SET_VERSION) fail('version');
  if (document.source !== 'openlibrary' || sourceKind !== 'openlibrary') fail('source');
  if (!Array.isArray(document.members) || document.members.length === 0) fail('manifest');
  if (document.members.length > OPEN_LIBRARY_DUMP_SET_MAX_MEMBERS) fail('manifest');

  const members: OpenLibraryDumpSetMember[] = [];
  const seenPaths = new Set<string>();
  const seenFamilies = new Set<OpenLibraryDumpFamily>();
  const origin = dirname(resolvedManifest);
  for (let index = 0; index < document.members.length; index++) {
    const entry = document.members[index];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail('manifest', index);
    const memberKeys = ownKeys(entry);
    if (memberKeys.length !== 2 || !memberKeys.includes('family') || !memberKeys.includes('path')) fail('manifest', index);
    const family = Reflect.get(entry, 'family');
    const path = Reflect.get(entry, 'path');
    if (!isFamily(family)) fail('family', index);
    if (typeof path !== 'string' || !path.trim() || pathBytes(path) > OPEN_LIBRARY_DUMP_SET_MAX_PATH_BYTES)
      fail('path', index);
    rejectUrlOrExpansion(path);
    const resolved = isAbsolute(path) ? resolvePath(path) : resolvePath(origin, path);
    if (sameResolved(resolved, resolvedManifest)) fail('reserved-path', index);
    if (reserved.state && sameResolved(resolved, reserved.state)) fail('reserved-path', index);
    if (reserved.accountKey && sameResolved(resolved, reserved.accountKey)) fail('reserved-path', index);
    if (seenPaths.has(resolved)) fail('duplicate', index);
    seenPaths.add(resolved);
    seenFamilies.add(family);
    members.push({ index, family, path: resolved });
  }
  for (const family of FAMILIES) if (!seenFamilies.has(family)) fail('family');
  for (const member of members) await assertAvailableMember(member.path, member.index);
  return {
    version: OPEN_LIBRARY_DUMP_SET_VERSION,
    sourceKind: 'openlibrary',
    manifestPath: resolvedManifest,
    members,
  };
}
