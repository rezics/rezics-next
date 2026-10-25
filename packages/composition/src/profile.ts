// SPDX-License-Identifier: Apache-2.0
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import canonicalize from 'canonicalize';
import type {
  CompositionDocument,
  CompositionRegistry,
  CompositionViolation,
  CompositionViolationCode,
} from './registry.ts';
import { CURIE, curie } from './strings.ts';
import { validateComposition } from './validate.ts';

/** Identifier of a presentation profile. */
export const PROFILE_FORMAT = 'https://rezics.com/presentation/profile/1';

/** RFC 8785 canonical UTF-8 byte budget for one profile. */
export const MAX_PROFILE_BYTES = 1_048_576;

/**
 * Templates in `bases`, `types` and `routes` together.
 * The generic page is not an entry in that count.
 */
export const MAX_PROFILE_TEMPLATES = 128;

const MAX_VIOLATIONS = 64;
/** A profile route key is at most this many characters. */
export const PROFILE_ROUTE_MAX_LENGTH = 256;
// `curie()` admits this many characters. The pattern itself does not limit length.
const CURIE_MAX_LENGTH = (curie() as unknown as { maxLength: number }).maxLength;
// `$` matches before a final newline. `(?![\s\S])` is the end, as in the other string rules.
/** The route key pattern `validateProfile` uses. It does not limit length. */
export const PROFILE_ROUTE_PATTERN = '^/(?:[a-z0-9]+(?:-[a-z0-9]+)*(?:/[a-z0-9]+(?:-[a-z0-9]+)*)*)?(?![\\s\\S])';
const ROUTE = new RegExp(PROFILE_ROUTE_PATTERN, 'u');

const PRIORITY: Record<CompositionViolationCode, number> = {
  limit: 4,
  unsafe: 3,
  duplicate: 2,
  unknown_type: 2,
  invalid: 1,
};

const ENVELOPE = new Set(['format', 'generic', 'bases', 'types', 'routes']);

interface Column {
  list: 'bases' | 'types' | 'routes';
  key: 'base' | 'type' | 'route';
  valid: (value: string) => boolean;
}

export interface ProfileBaseTemplate {
  base: string;
  document: CompositionDocument;
}

export interface ProfileTypeTemplate {
  type: string;
  document: CompositionDocument;
}

export interface ProfileRouteTemplate {
  route: string;
  document: CompositionDocument;
}

/** One generic page plus templates keyed by structural base, type and route. */
export interface PresentationProfile {
  format: typeof PROFILE_FORMAT;
  generic: CompositionDocument;
  bases: ProfileBaseTemplate[];
  types: ProfileTypeTemplate[];
  routes: ProfileRouteTemplate[];
}

/** What a page read knows about the subject. `bases` are nearest first. */
export interface TemplateTarget {
  route?: string;
  type?: string;
  bases?: readonly string[];
}

export interface ResolvedTemplate {
  scope: 'route' | 'type' | 'base' | 'generic';
  key: string | null;
  document: CompositionDocument;
}

type Add = (pointer: string, code: CompositionViolationCode) => void;

const COLUMNS: readonly Column[] = [
  { list: 'bases', key: 'base', valid: isCurie },
  { list: 'types', key: 'type', valid: isCurie },
  { list: 'routes', key: 'route', valid: isRoute },
];

function isCurie(value: string): boolean {
  return value.length <= CURIE_MAX_LENGTH && CURIE.test(value);
}

function isRoute(value: string): boolean {
  return value.length <= PROFILE_ROUTE_MAX_LENGTH && ROUTE.test(value);
}

function token(segment: string): string {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1');
}

function join(pointer: string, segment: string | number): string {
  return `${pointer}/${typeof segment === 'number' ? segment : token(segment)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function put(found: Map<string, CompositionViolationCode>, pointer: string, code: CompositionViolationCode): void {
  const current = found.get(pointer);
  if (current === undefined || PRIORITY[code] > PRIORITY[current]) found.set(pointer, code);
}

function finish(found: Map<string, CompositionViolationCode>): CompositionViolation[] {
  const violations = [...found.entries()].map(([pointer, code]) => ({ pointer, code }));
  violations.sort((left, right) => (left.pointer < right.pointer ? -1 : left.pointer > right.pointer ? 1 : 0));
  return violations.slice(0, MAX_VIOLATIONS);
}

/** A value this large cannot have a canonical form within the byte budget. */
function provablyOverLimit(value: unknown): boolean {
  const seen = new WeakSet<object>();
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === 'string') {
      if (current.length > MAX_PROFILE_BYTES) return true;
      continue;
    }
    if (current === null || typeof current !== 'object') continue;
    if (seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) {
      if (current.length > MAX_PROFILE_BYTES) return true;
      for (let index = 0; index < current.length; index++) pending.push(current[index]);
      continue;
    }
    const keys = Object.keys(current);
    if (keys.length > MAX_PROFILE_BYTES) return true;
    for (const key of keys) {
      if (key.length > MAX_PROFILE_BYTES) return true;
      pending.push((current as Record<string, unknown>)[key]);
    }
  }
  return false;
}

function canonicalBytes(value: unknown): number | undefined {
  const text = canonicalize(value);
  return typeof text === 'string' ? new TextEncoder().encode(text).byteLength : undefined;
}

function adopt(registry: CompositionRegistry, document: unknown, pointer: string, add: Add): void {
  let violations: CompositionViolation[];
  try {
    violations = validateComposition(registry, document);
  } catch {
    add(pointer, 'invalid');
    return;
  }
  for (const violation of violations) add(pointer + violation.pointer, violation.code);
}

function validateKeyedList(
  registry: CompositionRegistry,
  value: Record<string, unknown>,
  column: Column,
  add: Add,
): void {
  const listPointer = join('', column.list);
  if (!Object.hasOwn(value, column.list)) {
    add(listPointer, 'invalid');
    return;
  }
  const list = value[column.list];
  if (!Array.isArray(list)) {
    add(listPointer, 'invalid');
    return;
  }
  // Compared only with the entry just before it. A missing string key breaks the chain.
  let previous: string | undefined;
  for (let index = 0; index < list.length; index++) {
    const entryPointer = join(listPointer, index);
    const entry = list[index];
    if (!isRecord(entry)) {
      add(entryPointer, 'invalid');
      previous = undefined;
      continue;
    }
    for (const key of Object.keys(entry)) {
      if (key !== column.key && key !== 'document') add(join(entryPointer, key), 'invalid');
    }
    const keyPointer = join(entryPointer, column.key);
    if (!Object.hasOwn(entry, column.key)) {
      add(keyPointer, 'invalid');
      previous = undefined;
    } else {
      const keyValue = entry[column.key];
      if (typeof keyValue !== 'string' || !column.valid(keyValue)) add(keyPointer, 'invalid');
      if (typeof keyValue === 'string') {
        if (previous !== undefined) {
          if (keyValue === previous) add(keyPointer, 'duplicate');
          else if (keyValue < previous) add(keyPointer, 'invalid');
        }
        previous = keyValue;
      } else previous = undefined;
    }
    const documentPointer = join(entryPointer, 'document');
    if (!Object.hasOwn(entry, 'document')) add(documentPointer, 'invalid');
    else adopt(registry, entry.document, documentPointer, add);
  }
}

function validateEnvelope(registry: CompositionRegistry, value: unknown, add: Add): void {
  if (!isRecord(value)) {
    add('', 'invalid');
    return;
  }
  for (const key of Object.keys(value)) {
    if (!ENVELOPE.has(key)) add(join('', key), 'invalid');
  }
  if (!Object.hasOwn(value, 'format') || value.format !== PROFILE_FORMAT) add('/format', 'invalid');
  if (!Object.hasOwn(value, 'generic')) add('/generic', 'invalid');
  else adopt(registry, value.generic, '/generic', add);
  for (const column of COLUMNS) validateKeyedList(registry, value, column, add);
}

function templateCount(value: unknown): number {
  if (!isRecord(value)) return 0;
  let count = 0;
  for (const column of COLUMNS) {
    if (!Object.hasOwn(value, column.list)) continue;
    const list = value[column.list];
    if (Array.isArray(list)) count += list.length;
  }
  return count;
}

/** Pure publish-time check. Parsed JSON does not throw, and the input is not mutated. */
export function validateProfile(registry: CompositionRegistry, value: unknown): CompositionViolation[] {
  try {
    if (provablyOverLimit(value)) return [{ pointer: '', code: 'limit' }];
    const bytes = canonicalBytes(value);
    if (bytes === undefined) return [{ pointer: '', code: 'invalid' }];
    if (bytes > MAX_PROFILE_BYTES) return [{ pointer: '', code: 'limit' }];
  } catch {
    return [{ pointer: '', code: 'invalid' }];
  }
  if (templateCount(value) > MAX_PROFILE_TEMPLATES) return [{ pointer: '', code: 'limit' }];
  const found = new Map<string, CompositionViolationCode>();
  validateEnvelope(registry, value, (pointer, code) => put(found, pointer, code));
  return finish(found);
}

/** `sha256:` and the lowercase hex SHA-256 of the RFC 8785 canonical UTF-8 JSON. */
export function profileDigest(profile: PresentationProfile): string {
  return `sha256:${bytesToHex(sha256(utf8ToBytes(canonicalize(profile)!)))}`;
}

/** Binary search. `entries` are sorted by `read` in code-unit order. */
function findSorted<T>(entries: readonly T[], key: string, read: (entry: T) => string): T | undefined {
  let low = 0;
  let high = entries.length - 1;
  while (low <= high) {
    const mid = low + ((high - low) >> 1);
    const current = read(entries[mid]!);
    if (current === key) return entries[mid];
    if (current < key) low = mid + 1;
    else high = mid - 1;
  }
  return undefined;
}

/** Route, then type, then structural bases nearest first, then the generic page. */
export function resolveTemplate(profile: PresentationProfile, target: TemplateTarget): ResolvedTemplate {
  if (target.route !== undefined) {
    const found = findSorted(profile.routes, target.route, (entry) => entry.route);
    if (found) return { scope: 'route', key: found.route, document: found.document };
  }
  if (target.type !== undefined) {
    const found = findSorted(profile.types, target.type, (entry) => entry.type);
    if (found) return { scope: 'type', key: found.type, document: found.document };
  }
  const bases = target.bases;
  if (bases !== undefined) {
    for (let index = 0; index < bases.length; index++) {
      const base = bases[index]!;
      const found = findSorted(profile.bases, base, (entry) => entry.base);
      if (found) return { scope: 'base', key: found.base, document: found.document };
    }
  }
  return { scope: 'generic', key: null, document: profile.generic };
}
