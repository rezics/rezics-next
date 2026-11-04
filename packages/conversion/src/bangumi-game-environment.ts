import { types as utilTypes } from 'node:util';
import { bundledRelease } from '@rezics/definitions/bundled';
import type { ConversionDiagnostic } from './index.ts';
import { inLanguageTag, type ConversionContext } from './support.ts';

export const bangumiGameTemplateHead = '{{Infobox Game';
export const bangumiGameEnvironmentLimits = Object.freeze({
  sourceBytes: 65_536,
  maxTemplateDepth: 2,
  maxFields: 64,
  maxDiagnostics: 16,
  maxPlatforms: 16,
  maxEngines: 8,
  maxItemCodepoints: 200,
  maxItemBytes: 4_096,
  commandEnvelopeBytes: 65_536,
});

const platformKey = '平台';
const engineKey = '游戏引擎';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const horizontalSpace = /^[\t ]+|[\t ]+$/gu;
const engineQualification = /[0-9()（）[\]{}\\/|,，;；]/u;
const otherProviderHost = /(?:^|\.)vndb\.org$/iu;

export type BangumiGameEnvironmentProperty = 'schema:gamePlatform' | 'wdt:P408';
export type BangumiGameEnvironmentItem = Readonly<{
  kind: 'platform' | 'engine';
  property: BangumiGameEnvironmentProperty;
  pointer: string;
  item: string;
  language?: string;
}>;
export type BangumiGameEnvironmentFact = Readonly<{
  property: BangumiGameEnvironmentProperty;
  content: string;
  field: string;
  pointer: string;
  citationPath: string;
  qualifiers?: readonly Readonly<{ property: 'schema:inLanguage'; content: string }>[];
}>;
export type BangumiGameEnvironmentMapping = Readonly<{
  handledInfobox: boolean;
  items: readonly BangumiGameEnvironmentItem[];
  facts: readonly BangumiGameEnvironmentFact[];
  diagnostics: readonly ConversionDiagnostic[];
}>;

type Line = Readonly<{ text: string; number: number }>;
type StagedField = {
  key: string;
  pointer: string;
  form: 'empty' | 'scalar' | 'list';
  items: string[];
  language?: string[];
  nested: boolean;
  unsupported: boolean;
  complete: boolean;
};

function* sourceLines(text: string): Generator<Line> {
  let start = 0;
  let number = 0;
  while (start <= text.length) {
    const newline = text.indexOf('\n', start);
    const end = newline === -1 ? text.length : newline;
    let line = text.slice(start, end);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    yield { text: line, number };
    number++;
    if (newline === -1) return;
    start = newline + 1;
  }
}

function cleanHorizontal(value: string): string {
  return value.replace(horizontalSpace, '');
}

function infoboxPointer(key: string, index?: number): string {
  const field = `/infobox/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`;
  return index === undefined ? field : `${field}/${index}`;
}

function usableItem(value: string): boolean {
  return (
    value.isWellFormed() &&
    value.trim() === value &&
    value.length > 0 &&
    [...value].length <= bangumiGameEnvironmentLimits.maxItemCodepoints &&
    Buffer.byteLength(value, 'utf8') <= bangumiGameEnvironmentLimits.maxItemBytes &&
    !/[\u0000-\u001f\u007f]/u.test(value) &&
    !value.includes('{{') &&
    !value.includes('}}') &&
    !value.includes('[[') &&
    !value.includes(']]')
  );
}

function braces(line: string, depth: number): { depth: number; exceeded: boolean; invalid: boolean } {
  let nextDepth = depth;
  for (let i = 0; i < line.length; i++) {
    if (line.startsWith('{{', i)) {
      nextDepth++;
      if (nextDepth > bangumiGameEnvironmentLimits.maxTemplateDepth)
        return { depth: nextDepth, exceeded: true, invalid: false };
      i++;
    } else if (line.startsWith('}}', i)) {
      nextDepth--;
      if (nextDepth < 1) return { depth: nextDepth, exceeded: false, invalid: true };
      i++;
    }
  }
  return { depth: nextDepth, exceeded: false, invalid: false };
}

function diagnosticsSink() {
  const diagnostics: ConversionDiagnostic[] = [];
  let overflow = false;
  return {
    diagnostics,
    add(pointer: string, code: string) {
      if (overflow) return;
      if (diagnostics.length < bangumiGameEnvironmentLimits.maxDiagnostics - 1) diagnostics.push({ pointer, code });
      else {
        diagnostics.push({ pointer: '/infobox', code: 'additional_infobox_omissions' });
        overflow = true;
      }
    },
  };
}

/** Exact source-item lookup key; uses the released property term, never a minted infobox-field scheme. */
export function bangumiGameEnvironmentReferenceKey(property: BangumiGameEnvironmentProperty, item: string): string {
  const key = `v1:${JSON.stringify([property, item])}`;
  if (!item.isWellFormed() || key.length > 255 || Buffer.byteLength(key, 'utf8') > 255)
    throw new TypeError('Invalid game environment reference');
  return key;
}

export function isBangumiGameTemplateHead(line: string): boolean {
  return line.trim() === bangumiGameTemplateHead;
}

function parseListItem(raw: string): { item: string; language?: string; malformed: boolean } | undefined {
  const text = cleanHorizontal(raw);
  if (!text.startsWith('[') || !text.endsWith(']')) return;
  const body = text.slice(1, -1);
  const separator = body.indexOf('|');
  if (separator < 0) {
    const item = cleanHorizontal(body);
    return item ? { item, malformed: !usableItem(item) } : { item: '', malformed: true };
  }
  if (body.indexOf('|', separator + 1) !== -1) return { item: '', malformed: true };
  const item = cleanHorizontal(body.slice(0, separator));
  const language = cleanHorizontal(body.slice(separator + 1));
  if (!item || !usableItem(item) || !language || !language.isWellFormed()) return { item, malformed: true };
  return { item, language, malformed: false };
}

function engineQualified(item: string): boolean {
  return engineQualification.test(item);
}

function admitted(property: BangumiGameEnvironmentProperty, qualifier?: string): boolean {
  const type = bundledRelease.types['schema:VideoGame'];
  const definition = bundledRelease.properties[property];
  if (!type?.properties.includes(property) || definition?.datatype !== 'wikibase-item') return false;
  if (!definition.targets?.includes('skos:Concept')) return false;
  if (!qualifier) return true;
  return definition.qualifiers.includes(qualifier) && !!bundledRelease.properties[qualifier];
}

function readReference(
  dictionary: ConversionContext['resolvedReferences'],
  property: BangumiGameEnvironmentProperty,
  item: string,
): string | undefined {
  let key: string;
  try {
    key = bangumiGameEnvironmentReferenceKey(property, item);
  } catch {
    return;
  }
  if (!dictionary) return;
  const descriptor = Object.getOwnPropertyDescriptor(dictionary, key);
  if (!descriptor) return;
  if (!('value' in descriptor) || !descriptor.enumerable) throw new TypeError('invalid_reference_context');
  const concept = descriptor.value;
  if (concept === undefined) return;
  if (typeof concept !== 'string' || !uuid.test(concept)) throw new TypeError('invalid_reference_context');
  return concept;
}

/**
 * Parse only pinned `{{Infobox Game` 平台 and 游戏引擎 occurrences. Top-level
 * subject.platform stays a separate profile selector.
 */
export function bangumiGameEnvironment(
  record: { readonly type: number; readonly infobox?: string },
  context: ConversionContext = {},
): BangumiGameEnvironmentMapping {
  const sink = diagnosticsSink();
  const empty = (handledInfobox: boolean): BangumiGameEnvironmentMapping => ({
    handledInfobox,
    items: [],
    facts: [],
    diagnostics: sink.diagnostics,
  });
  if (record.type !== 4 || record.infobox === undefined) return empty(false);
  const infobox = record.infobox;
  if (!infobox.isWellFormed()) {
    sink.add('/infobox', 'unsupported_infobox_structure');
    return empty(false);
  }
  if (Buffer.byteLength(infobox, 'utf8') > bangumiGameEnvironmentLimits.sourceBytes) {
    sink.add('/infobox', 'infobox_byte_limit');
    return empty(false);
  }

  const fields: StagedField[] = [];
  let active: StagedField | undefined;
  let fieldCount = 0;
  let depth = 1;
  let closed = false;
  let trailing = false;
  let fieldOverflow = false;
  let depthExceeded = false;
  let seenHeader = false;

  const finish = (field: StagedField | undefined, complete = true) => {
    if (!field) return;
    field.complete = complete;
    if (field.key === platformKey || field.key === engineKey) fields.push(field);
  };

  for (const row of sourceLines(infobox)) {
    const trimmed = cleanHorizontal(row.text);
    if (!trimmed) continue;
    if (!seenHeader) {
      if (!isBangumiGameTemplateHead(row.text)) return empty(false);
      seenHeader = true;
      continue;
    }
    if (closed) {
      if (trimmed) trailing = true;
      continue;
    }
    const nested = braces(row.text, depth);
    if (nested.exceeded) {
      sink.add(active?.pointer ?? '/infobox', 'infobox_depth_limit');
      depthExceeded = true;
      if (active) active.nested = true;
      break;
    }
    if (depth === 1 && trimmed === '}}') {
      finish(active);
      active = undefined;
      closed = true;
      depth = 0;
      continue;
    }
    if (depth > 1) {
      if (active) {
        if (active.key === platformKey || active.key === engineKey) {
          if (trimmed === '}') {
            finish(active);
            active = undefined;
            depth = nested.depth < depth ? nested.depth : 1;
            continue;
          }
          const parsed = parseListItem(trimmed);
          if (!parsed) {
            active.unsupported = true;
          } else {
            active.form = 'list';
            active.items.push(parsed.item);
            active.language = active.language ?? [];
            active.language.push(parsed.malformed ? '\u0000' : (parsed.language ?? ''));
            if (parsed.malformed) active.unsupported = true;
          }
        } else active.nested = true;
      }
      if (nested.invalid) {
        sink.add('/infobox', 'unsupported_infobox_structure');
        depthExceeded = true;
        break;
      }
      depth = nested.depth;
      continue;
    }
    if (trimmed.startsWith('|')) {
      finish(active);
      active = undefined;
      fieldCount++;
      if (fieldCount > bangumiGameEnvironmentLimits.maxFields) {
        if (!fieldOverflow) sink.add('/infobox', 'infobox_field_limit');
        fieldOverflow = true;
        continue;
      }
      const equals = row.text.indexOf('=');
      const pointer = `/infobox/fields/${fieldCount - 1}`;
      if (equals < 1) {
        sink.add(pointer, 'unsupported_infobox_structure');
        continue;
      }
      const key = cleanHorizontal(row.text.slice(1, equals));
      const rawValue = row.text.slice(equals + 1);
      const value = cleanHorizontal(rawValue);
      if (!key) {
        sink.add(pointer, 'unsupported_infobox_structure');
        continue;
      }
      const consumed = key === platformKey || key === engineKey;
      active = {
        key,
        pointer: infoboxPointer(key),
        form: 'empty',
        items: [],
        nested: false,
        unsupported: false,
        complete: false,
      };
      if (!consumed) {
        if (nested.depth > 1) {
          active.nested = true;
          depth = nested.depth;
        }
        continue;
      }
      if (value === '{' || value === '') {
        active.form = value === '{' ? 'list' : 'empty';
        if (value === '{') depth = Math.max(depth, 2);
        continue;
      }
      const listed = parseListItem(value);
      if (listed) {
        active.form = 'list';
        active.items.push(listed.item);
        active.language = [listed.malformed ? '\u0000' : (listed.language ?? '')];
        if (listed.malformed) active.unsupported = true;
        continue;
      }
      active.form = 'scalar';
      active.items.push(value);
      continue;
    }
    if (active && (active.key === platformKey || active.key === engineKey) && active.form !== 'scalar') {
      if (trimmed === '{') {
        active.form = 'list';
        depth = 2;
        continue;
      }
      if (trimmed.startsWith('*')) {
        active.unsupported = true;
        continue;
      }
      const parsed = parseListItem(trimmed);
      if (parsed) {
        active.form = 'list';
        active.items.push(parsed.item);
        active.language = active.language ?? [];
        active.language.push(parsed.malformed ? '\u0000' : (parsed.language ?? ''));
        if (parsed.malformed) active.unsupported = true;
        continue;
      }
      if (active.form === 'empty') {
        active.form = 'scalar';
        active.items.push(trimmed);
        continue;
      }
    }
    sink.add(`/infobox/lines/${row.number}`, 'unsupported_infobox_structure');
    if (nested.invalid) {
      sink.add('/infobox', 'unsupported_infobox_structure');
      depthExceeded = true;
      break;
    }
    depth = nested.depth;
  }
  finish(active, closed);
  if (!seenHeader) return empty(false);
  if (!closed && !depthExceeded) sink.add('/infobox', 'unsupported_infobox_structure');
  if (trailing) sink.add('/infobox', 'unsupported_infobox_structure');
  if (fieldOverflow || depthExceeded || !closed || trailing) return empty(true);

  if (
    context.resolvedReferences !== undefined &&
    (context.resolvedReferences === null ||
      typeof context.resolvedReferences !== 'object' ||
      utilTypes.isProxy(context.resolvedReferences) ||
      Array.isArray(context.resolvedReferences))
  )
    throw new TypeError('invalid_reference_context');

  const items: BangumiGameEnvironmentItem[] = [];
  const facts: BangumiGameEnvironmentFact[] = [];
  const seenKeys = new Set<string>();
  let platforms = 0;
  let engines = 0;

  for (const field of fields) {
    if (seenKeys.has(field.key)) {
      sink.add(field.pointer, 'duplicate_environment_field');
      continue;
    }
    seenKeys.add(field.key);
    const kind = field.key === platformKey ? 'platform' : 'engine';
    const property: BangumiGameEnvironmentProperty = kind === 'platform' ? 'schema:gamePlatform' : 'wdt:P408';
    const cap = kind === 'platform' ? bangumiGameEnvironmentLimits.maxPlatforms : bangumiGameEnvironmentLimits.maxEngines;
    if (!field.complete || field.nested) {
      sink.add(field.pointer, 'unsupported_infobox_structure');
      continue;
    }
    if (field.unsupported) {
      sink.add(field.pointer, kind === 'engine' ? 'engine_qualification_unadmitted' : 'unsupported_infobox_item');
      continue;
    }
    if (!admitted(property)) {
      sink.add(field.pointer, 'property_not_admitted');
      continue;
    }
    for (let index = 0; index < field.items.length; index++) {
      const pointer = infoboxPointer(field.key, index);
      const item = cleanHorizontal(field.items[index] ?? '');
      const languageToken = field.language?.[index];
      if (!item) continue;
      if ((kind === 'platform' ? platforms : engines) >= cap) {
        sink.add(pointer, kind === 'platform' ? 'platform_occurrence_limit' : 'engine_occurrence_limit');
        continue;
      }
      if (!usableItem(item)) {
        sink.add(pointer, 'unsupported_infobox_item');
        continue;
      }
      if (kind === 'engine' && (languageToken || engineQualified(item))) {
        sink.add(pointer, 'engine_qualification_unadmitted');
        continue;
      }
      let language: string | undefined;
      if (languageToken) {
        if (languageToken === '\u0000') {
          sink.add(pointer, 'unsupported_platform_language_qualifier');
          continue;
        }
        if (!admitted(property, 'schema:inLanguage')) {
          sink.add(pointer, 'unsupported_platform_language_qualifier');
          continue;
        }
        const tag = inLanguageTag(languageToken);
        if (!tag) {
          sink.add(pointer, 'unsupported_platform_language_qualifier');
          continue;
        }
        language = tag;
      }
      if (kind === 'platform') platforms++;
      else engines++;
      items.push({ kind, property, pointer, item, ...(language ? { language } : {}) });
      let concept: string | undefined;
      try {
        concept = readReference(context.resolvedReferences, property, item);
      } catch {
        throw new TypeError('invalid_reference_context');
      }
      if (!concept) {
        sink.add(pointer, 'source_binding_unavailable');
        continue;
      }
      facts.push({
        property,
        content: concept,
        field: `${kind}:${item}${language ? `:${language}` : ''}`,
        pointer,
        citationPath: pointer,
        ...(language ? { qualifiers: [{ property: 'schema:inLanguage', content: language }] } : {}),
      });
    }
  }

  return { handledInfobox: true, items, facts, diagnostics: sink.diagnostics };
}

export function bangumiGameEnvironmentSourceHost(hostname: string): boolean {
  return hostname === 'bgm.tv' || hostname === 'bangumi.tv' || hostname === 'chii.in';
}

export function bangumiGameEnvironmentForeignHost(hostname: string): boolean {
  return otherProviderHost.test(hostname);
}
