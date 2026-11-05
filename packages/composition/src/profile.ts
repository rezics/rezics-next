// SPDX-License-Identifier: Apache-2.0
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import canonicalize from 'canonicalize';
import type { FilterRelease } from '@rezics/filter';
import { validateDocumentFilters } from './filter.ts';
import type {
  CompositionDocument,
  CompositionRegistry,
  CompositionViolation,
  CompositionViolationCode,
} from './registry.ts';
import { CURIE, curie } from './strings.ts';
import { validateComposition } from './validate.ts';
import { isView, VIEWS, type View, type ViewDocuments } from './views.ts';

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

/**
 * A template's documents: `views` holds one document per view, and `document` alone is the shorthand for a template
 * that has only its overview.
 */
export type TemplateBody =
  | { document: CompositionDocument; views?: undefined }
  | { views: ViewDocuments; document?: undefined };

export type ProfileBaseTemplate = { base: string } & TemplateBody;

export type ProfileTypeTemplate = { type: string } & TemplateBody;

export type ProfileRouteTemplate = { route: string } & TemplateBody;

/** The generic page: its overview document, or `{ views }`. */
export type GenericTemplate = CompositionDocument | { views: ViewDocuments };

/** One generic page plus templates keyed by structural base, type and route. */
export interface PresentationProfile {
  format: typeof PROFILE_FORMAT;
  generic: GenericTemplate;
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

/** The documents of `views`: only the closed view names, `overview` present, each a valid composition. */
function validateViews(registry: CompositionRegistry, value: unknown, pointer: string, add: Add): void {
  if (!isRecord(value)) {
    add(pointer, 'invalid');
    return;
  }
  for (const key of Object.keys(value)) {
    if (!isView(key)) add(join(pointer, key), 'invalid');
  }
  if (!Object.hasOwn(value, 'overview')) add(join(pointer, 'overview'), 'invalid');
  for (const view of VIEWS) {
    if (Object.hasOwn(value, view)) adopt(registry, value[view], join(pointer, view), add);
  }
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
      if (key !== column.key && key !== 'document' && key !== 'views') add(join(entryPointer, key), 'invalid');
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
    const viewsPointer = join(entryPointer, 'views');
    if (Object.hasOwn(entry, 'views')) {
      if (Object.hasOwn(entry, 'document')) add(documentPointer, 'invalid');
      validateViews(registry, entry.views, viewsPointer, add);
    } else if (!Object.hasOwn(entry, 'document')) add(documentPointer, 'invalid');
    if (Object.hasOwn(entry, 'document') && !Object.hasOwn(entry, 'views'))
      adopt(registry, entry.document, documentPointer, add);
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
  else if (isRecord(value.generic) && Object.hasOwn(value.generic, 'views')) {
    for (const key of Object.keys(value.generic)) {
      if (key !== 'views') add(join('/generic', key), 'invalid');
    }
    validateViews(registry, value.generic.views, '/generic/views', add);
  } else adopt(registry, value.generic, '/generic', add);
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

/** The documents of a template: its `views`, or its lone `document` as the overview. */
export function templateViews(template: TemplateBody | GenericTemplate): Partial<ViewDocuments> {
  if ('views' in template && template.views !== undefined) return template.views;
  if ('document' in template && template.document !== undefined) return { overview: template.document };
  return { overview: template as CompositionDocument };
}

type Candidate = { scope: ResolvedTemplate['scope']; key: string | null; template: TemplateBody | GenericTemplate };

/** Route, then type, then structural bases nearest first, then the generic page. */
function candidates(profile: PresentationProfile, target: TemplateTarget): Candidate[] {
  const found: Candidate[] = [];
  if (target.route !== undefined) {
    const entry = findSorted(profile.routes, target.route, (item) => item.route);
    if (entry) found.push({ scope: 'route', key: entry.route, template: entry });
  }
  if (target.type !== undefined) {
    const entry = findSorted(profile.types, target.type, (item) => item.type);
    if (entry) found.push({ scope: 'type', key: entry.type, template: entry });
  }
  const bases = target.bases;
  if (bases !== undefined) {
    for (let index = 0; index < bases.length; index++) {
      const base = bases[index]!;
      const entry = findSorted(profile.bases, base, (item) => item.base);
      if (entry) found.push({ scope: 'base', key: entry.base, template: entry });
    }
  }
  found.push({ scope: 'generic', key: null, template: profile.generic });
  return found;
}

/**
 * The template that answers the target, then its document for the view. A template that lacks the view yields to the
 * next in the resolution order, and the generic page is last; `null` when none defines the view.
 */
export function resolveView(profile: PresentationProfile, target: TemplateTarget, view: View): ResolvedTemplate | null {
  for (const { scope, key, template } of candidates(profile, target)) {
    const document = templateViews(template)[view];
    if (document !== undefined) return { scope, key, document };
  }
  return null;
}

/** The views any template of the resolution order defines, in the order a page offers them. */
export function definedViews(profile: PresentationProfile, target: TemplateTarget): View[] {
  const chain = candidates(profile, target).map(({ template }) => templateViews(template));
  return VIEWS.filter((view) => chain.some((views) => views[view] !== undefined));
}

/**
 * Route, then type, then structural bases nearest first, then the generic page. The document is the overview of the
 * first template in that order; the `bases` of a template are consulted for other views through `resolveView`.
 */
export function resolveTemplate(profile: PresentationProfile, target: TemplateTarget): ResolvedTemplate {
  const resolved = resolveView(profile, target, 'overview');
  if (!resolved) throw new Error('A profile always defines the generic overview');
  return resolved;
}

/** Structural validation precedes this release-dependent publication check. */
export function validateProfileFilters(
  registry: CompositionRegistry,
  profile: PresentationProfile,
  release: FilterRelease,
): CompositionViolation[] {
  const errors: CompositionViolation[] = [];
  const templates: [string, TemplateBody | GenericTemplate][] = [
    ['/generic', profile.generic],
    ...profile.bases.map((entry, index): [string, TemplateBody] => [`/bases/${index}`, entry]),
    ...profile.types.map((entry, index): [string, TemplateBody] => [`/types/${index}`, entry]),
    ...profile.routes.map((entry, index): [string, TemplateBody] => [`/routes/${index}`, entry]),
  ];
  for (const [pointer, template] of templates) {
    for (const [view, document] of Object.entries(templateViews(template))) {
      const path =
        'views' in template ? `${pointer}/views/${view}` : 'document' in template ? `${pointer}/document` : pointer;
      for (const violation of validateDocumentFilters(registry, document!, release))
        errors.push({ ...violation, pointer: path + violation.pointer });
    }
  }
  return errors.sort((a, b) => (a.pointer < b.pointer ? -1 : a.pointer > b.pointer ? 1 : 0)).slice(0, 64);
}
