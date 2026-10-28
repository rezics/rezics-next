import {
  checkBatchWrite,
  type BatchCommand,
  type BatchReference,
  type BatchStatement,
  type FieldGroup,
} from '@rezics/definitions/bulk';
import { checkMediaImportRequest, type MediaImportRequest } from '@rezics/definitions/media-import';
import { ConversionError, type ConversionInput, type ConvertedRecord } from './index.ts';
import {
  commandKey,
  marcLanguageTag,
  safeSourceUrl,
  sourceDigest,
  sourceEnvelope,
  type ConversionContext,
} from './support.ts';

export const converter_revision = 'open-library@3';

// Explicit allowlist: fifteen top-level fields; each collection <=64 entries,
// authors + works <=64 relations; <=100 commands; <=64 deferred cover assets.
// Projection <=2 MiB, unknown-licensed prose <=1 MiB, other strings <=1500
// characters (title included). Unknown/private subtrees are never traversed.
// One projection pass, canonical sorting O(M log M), bounded construction O(M).
const recordBytes = 2 * 1024 * 1024;
const proseBytes = 1024 * 1024;
const fieldCap = 64;
const calendar = 'http://www.wikidata.org/entity/Q1985727';
type Time = { time: string; precision: number; calendarmodel: string };
type Key = { key?: string };
type NormalizedRecord = {
  type: { key: '/type/work' | '/type/edition' };
  key: string;
  revision: number;
  last_modified: { value: string };
  title: string;
  authors?: Key[];
  works?: Key[];
  isbn_10?: string[];
  isbn_13?: string[];
  publish_date?: string;
  description?: string;
  covers?: number[];
  links?: { url: string }[];
  publishers?: string[];
  languages?: { key: string }[];
};
type DeferredCover = Omit<MediaImportRequest, 'containerId'>;
export type OpenLibraryConversion = ConvertedRecord<BatchCommand> & {
  outcome: 'converted';
  record_revision: string;
  proposals: BatchCommand[];
  digest: string;
  /** Sanitized native payload; pass it directly as ConversionInput.record again. */
  normalizedRecord: NormalizedRecord;
  coverAssets: DeferredCover[];
  /** Complete public requests only; an available media mapping permits a proposal. */
  mediaImportIntents: MediaImportRequest[];
  sourceMetadata: {
    subjectType: 'schema:Book' | 'bf:Instance';
    recordUrl: string;
    bibliographyPermission: 'CC0-1.0';
    description?: { text: string; license: 'LicenseRef-unknown'; field_group: 'summary' };
    cover: { role: 'cover'; takedownEligible: true };
  };
};

function invalid(pointer: string, code = 'invalid_open_library_record'): never {
  throw new ConversionError(code, pointer);
}
function object(value: unknown, pointer: string): object {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(pointer);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(pointer);
  return value;
}
function own(value: object, key: string, pointer: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return undefined;
  if (!descriptor.enumerable || !('value' in descriptor)) invalid(pointer, 'expected_source_data_property');
  return descriptor.value;
}
function string(value: unknown, pointer: string, cap = 1500): string {
  if (typeof value !== 'string' || value.length > cap || !value.isWellFormed() || !value.trim())
    invalid(pointer, 'invalid_source_string_or_limit');
  return value;
}
function array<T>(value: unknown, pointer: string, read: (entry: unknown, path: string) => T): T[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) invalid(pointer);
  const length: unknown = Object.getOwnPropertyDescriptor(value, 'length')?.value;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length > fieldCap)
    invalid(pointer, 'source_field_limit_64');
  const result: T[] = [];
  for (let i = 0; i < length; i++) result.push(read(own(value, String(i), `${pointer}/${i}`), `${pointer}/${i}`));
  return result;
}
function relation(value: unknown, path: string, kind: 'authors' | 'works'): Key {
  let entry = object(value, path);
  // Work author roles wrap author; edition authors and sanitized authors are keys.
  const wrapped = kind === 'authors' ? own(entry, 'author', `${path}/author`) : undefined;
  if (wrapped !== undefined) entry = object(wrapped, `${path}/author`);
  const key = own(entry, 'key', `${path}/key`);
  if (key === undefined) return {};
  const pattern = kind === 'authors' ? /^\/authors\/OL[1-9][0-9]*A$/u : /^\/works\/OL[1-9][0-9]*W$/u;
  const text = string(key, `${path}/key`, 255);
  if (pattern.exec(text)?.[0] !== text) invalid(`${path}/key`, 'invalid_relation_key');
  return { key: text };
}
function dayExists(year: number, month: number, day: number): boolean {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!
  );
}
function modified(value: unknown): { value: string } {
  const stamp = string(
    own(object(value, '/last_modified'), 'value', '/last_modified/value'),
    '/last_modified/value',
    64,
  );
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?Z?$/u.exec(stamp);
  if (
    !match ||
    match[0] !== stamp ||
    !dayExists(Number(match[1]), Number(match[2]), Number(match[3])) ||
    Number(match[4]) > 23 ||
    Number(match[5]) > 59 ||
    Number(match[6]) > 59
  )
    invalid('/last_modified/value', 'invalid_source_timestamp');
  return { value: stamp };
}
function language(value: unknown, path: string): { key: string } {
  const text = string(own(object(value, path), 'key', `${path}/key`), `${path}/key`, 255);
  if (/^\/languages\/[^/]+$/u.exec(text)?.[0] !== text) invalid(`${path}/key`, 'invalid_language_key');
  return { key: text };
}
function link(value: unknown, path: string): { url: string } {
  const raw = own(object(value, path), 'url', `${path}/url`);
  try {
    if (typeof raw !== 'string') invalid(`${path}/url`, 'unsafe_source_link');
    const host = new URL(raw).hostname;
    // Arbitrary publisher links are metadata, never fetch instructions. Require
    // a public DNS-shaped HTTPS authority; CDN fetches use a fixed allowlist below.
    if (
      !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/u.test(host) ||
      /\.(?:localhost|local|internal|test|invalid)$/u.test(host)
    )
      invalid(`${path}/url`, 'unsafe_source_link');
    return { url: safeSourceUrl(raw, [host]) };
  } catch {
    invalid(`${path}/url`, 'unsafe_source_link');
  }
}
function normalize(input: ConversionInput): NormalizedRecord {
  const raw = object(input.record, '');
  const get = (key: string) => own(raw, key, `/${key}`);
  const type = own(object(get('type'), '/type'), 'key', '/type/key');
  if (type !== '/type/work' && type !== '/type/edition') invalid('/type/key', 'unsupported_open_library_type');
  const key = string(get('key'), '/key', 255);
  const pattern = type === '/type/work' ? /^\/works\/OL[1-9][0-9]*W$/u : /^\/books\/OL[1-9][0-9]*M$/u;
  if (pattern.exec(key)?.[0] !== key || input.external_id !== key) invalid('/key', 'invalid_record_key');
  const revision = get('revision');
  if (
    typeof revision !== 'number' ||
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    input.record_revision !== String(revision)
  )
    invalid('/revision', 'invalid_native_revision');
  const record: NormalizedRecord = {
    type: { key: type },
    key,
    revision,
    last_modified: modified(get('last_modified')),
    title: string(get('title'), '/title'),
  };
  for (const kind of ['authors', 'works'] as const) {
    const value = get(kind);
    if (value !== undefined) record[kind] = array(value, `/${kind}`, (entry, path) => relation(entry, path, kind));
  }
  if ((record.authors?.length ?? 0) + (record.works?.length ?? 0) > fieldCap)
    invalid('/authors', 'source_relation_limit_64');
  for (const kind of ['isbn_10', 'isbn_13', 'publishers'] as const) {
    const value = get(kind);
    if (value !== undefined) record[kind] = array(value, `/${kind}`, (entry, path) => string(entry, path));
  }
  const date = get('publish_date');
  if (date !== undefined) record.publish_date = string(date, '/publish_date');
  const description = get('description');
  if (description !== undefined) {
    const text = string(
      typeof description === 'string'
        ? description
        : own(object(description, '/description'), 'value', '/description/value'),
      '/description',
      proseBytes,
    );
    if (Buffer.byteLength(text, 'utf8') > proseBytes) invalid('/description', 'unknown_prose_byte_limit_1_MiB');
    record.description = text;
  }
  const covers = get('covers');
  if (covers !== undefined)
    record.covers = array(covers, '/covers', (entry, path) => {
      if (typeof entry !== 'number' || !Number.isSafeInteger(entry) || (entry !== -1 && entry < 1))
        invalid(path, 'invalid_cover_identifier');
      return entry;
    });
  const links = get('links');
  if (links !== undefined) record.links = array(links, '/links', link);
  const languages = get('languages');
  if (languages !== undefined) record.languages = array(languages, '/languages', language);
  if (Buffer.byteLength(JSON.stringify(record), 'utf8') > recordBytes) invalid('', 'source_record_byte_limit_2_MiB');
  return record;
}
function time(year: string, month = '00', day = '00'): Time {
  return {
    time: `+${year}-${month}-${day}T00:00:00Z`,
    precision: day !== '00' ? 11 : month !== '00' ? 10 : 9,
    calendarmodel: calendar,
  };
}
function publicationDate(value: string): Time | undefined {
  const iso = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/u.exec(value);
  const months = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];
  const english = /^([A-Za-z]+) (?:(\d{1,2}),? )?(\d{4})$/u.exec(value);
  let year: string, month: string | undefined, day: string | undefined;
  if (iso?.[0] === value) [year, month, day] = [iso[1]!, iso[2], iso[3]];
  else if (english?.[0] === value) {
    const index = months.findIndex((name) => name.toLowerCase() === english[1]!.toLowerCase());
    if (index < 0) return undefined;
    [year, month, day] = [english[3]!, String(index + 1).padStart(2, '0'), english[2]?.padStart(2, '0')];
  } else return undefined;
  if (
    month !== undefined &&
    (Number(month) < 1 ||
      Number(month) > 12 ||
      (day !== undefined && !dayExists(Number(year), Number(month), Number(day))))
  )
    invalid('/publish_date', 'invalid_publication_date');
  return time(year, month, day);
}
function isbn13(value: string, ten: boolean, pointer: string): string {
  const digits = value.replace(/[ -]/gu, '').toUpperCase();
  if (ten) {
    if (
      !/^\d{9}[\dX]$/u.test(digits) ||
      [...digits].reduce((sum, digit, i) => sum + (digit === 'X' ? 10 : Number(digit)) * (10 - i), 0) % 11 !== 0
    )
      invalid(pointer, 'invalid_isbn10_checksum');
    const prefix = `978${digits.slice(0, 9)}`;
    const sum = [...prefix].reduce((total, digit, i) => total + Number(digit) * (i % 2 ? 3 : 1), 0);
    return `${prefix}${(10 - (sum % 10)) % 10}`;
  }
  if (
    !/^97[89]\d{10}$/u.test(digits) ||
    [...digits].reduce((sum, digit, i) => sum + Number(digit) * (i % 2 ? 3 : 1), 0) % 10 !== 0
  )
    invalid(pointer, 'invalid_isbn13_checksum');
  return digits;
}

/** No I/O, native identity creation, adoption, source-controlled revision or clock. */
export function convertOpenLibrary(
  input: ConversionInput,
  context: ConversionContext = {},
  options: { readonly converterRevision?: string } = {},
): OpenLibraryConversion {
  try {
    return convert(input, context, options.converterRevision ?? converter_revision);
  } catch (error) {
    if (error instanceof ConversionError) throw error;
    invalid('', 'invalid_open_library_record_or_context');
  }
}
function convert(input: ConversionInput, context: ConversionContext, revision: string): OpenLibraryConversion {
  const record = normalize(input);
  const digest = sourceDigest(record);
  const metadata = {
    source: context.source ?? 'open-library',
    external_id: record.key,
    record_revision: String(record.revision),
    converter_revision: revision,
    digest,
  };
  const envelope = (group: FieldGroup) => sourceEnvelope(metadata, group);
  const recordUrl = `https://openlibrary.org${record.key}`;
  const identifier = (key: string) => key.slice(key.lastIndexOf('/') + 1);
  const part = (id: string, content: unknown) => ({ property: { id }, value: { type: 'value' as const, content } });
  const reference: BatchReference = {
    parts: [
      part('schema:url', recordUrl),
      part('wdt:P648', identifier(record.key)),
      part('schema:version', metadata.record_revision),
      part(
        'schema:dateModified',
        time(
          record.last_modified.value.slice(0, 4),
          record.last_modified.value.slice(5, 7),
          record.last_modified.value.slice(8, 10),
        ),
      ),
    ],
  };
  const key = (field: string, group: FieldGroup, statement?: BatchStatement) =>
    commandKey([
      metadata.source,
      record.key,
      metadata.record_revision,
      digest,
      revision,
      group,
      field,
      context.subjectId ?? 'bootstrap',
      // Bind identity to this bounded semantic body, not the resolution map.
      // The source digest above remains independent of native bindings.
      ...(statement === undefined ? [] : [sourceDigest(statement)]),
    ]);
  const proposals: BatchCommand[] = [];
  const diagnostics: OpenLibraryConversion['diagnostics'][number][] = [];
  const report = (pointer: string, code: string) => diagnostics.push({ pointer, code });
  const fact = (id: string, content: unknown): BatchStatement => ({ ...part(id, content), references: [reference] });
  const propose = (statement: BatchStatement, field: string, group: FieldGroup = 'facts') => {
    if (context.subjectId !== undefined)
      proposals.push({
        op: 'propose',
        key: key(field, group, statement),
        source: envelope(group),
        subject: context.subjectId,
        statement,
      });
  };
  const subjectType = record.type.key === '/type/work' ? 'schema:Book' : 'bf:Instance';
  if (context.subjectId === undefined)
    proposals.push({
      op: 'create',
      key: key('bootstrap', 'facts'),
      source: envelope('facts'),
      subject: { type: subjectType, labels: { und: record.title } },
    });
  propose(fact('wdt:P648', identifier(record.key)), 'identity');
  propose(fact('schema:name', { language: 'und', text: record.title }), 'title');
  const languageTags = new Set<string>();
  (record.languages ?? []).forEach((entry, i) => {
    const tag = marcLanguageTag(entry.key.slice('/languages/'.length));
    if (tag === null) {
      report(`/languages/${i}`, 'no_canonical_language_tag');
      return;
    }
    languageTags.add(tag);
  });
  for (const tag of [...languageTags].sort()) propose(fact('schema:inLanguage', tag), `language:${tag}`);
  for (const kind of ['authors', 'works'] as const) {
    (record[kind] ?? []).forEach((entry, i) => {
      if (entry.key === undefined) {
        report(`/${kind}/${i}`, 'missing_relation_identifier');
        return;
      }
      if (kind === 'works' && subjectType !== 'bf:Instance') {
        report('/works', 'schema:exampleOfWork_not_allowed_on_schema:Book');
        return;
      }
      const resolved = context.resolvedReferences?.[entry.key];
      if (
        resolved !== undefined &&
        (typeof resolved !== 'string' ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(resolved))
      )
        invalid(`/${kind}/${i}`, 'invalid_resolved_relation_uuid');
      propose(
        {
          property: { id: kind === 'authors' ? 'schema:author' : 'schema:exampleOfWork' },
          value: resolved === undefined ? { type: 'somevalue' } : { type: 'value', content: resolved },
          qualifiers: [part('wdt:P648', identifier(entry.key))],
          references: [reference],
        },
        `${kind}:${i}`,
      );
    });
  }
  const isbns = new Set<string>();
  for (const kind of ['isbn_10', 'isbn_13'] as const)
    (record[kind] ?? []).forEach((value, i) => {
      const normalized = isbn13(value, kind === 'isbn_10', `/${kind}/${i}`);
      if (subjectType === 'bf:Instance') isbns.add(normalized);
      else report(`/${kind}/${i}`, 'schema:isbn_not_allowed_on_schema:Book');
    });
  for (const isbn of isbns) propose(fact('schema:isbn', isbn), `isbn:${isbn}`);
  if (record.publish_date !== undefined) {
    const date = publicationDate(record.publish_date);
    if (date) propose(fact('schema:datePublished', date), 'publish_date');
    else report('/publish_date', 'unsupported_publication_date_format');
  }
  if (record.publishers?.length)
    report('/publishers', 'schema:publisher_requires_external_identifier_or_native_resolution');
  if (record.links?.length) report('/links', 'source_links_retained_as_metadata_only');
  if (record.description !== undefined) report('/description', 'unknown_prose_license_no_summary_permission');
  const coverAssets: DeferredCover[] = [];
  const mediaImportIntents: MediaImportRequest[] = [];
  for (const cover of new Set(record.covers ?? [])) {
    if (cover === -1) {
      report('/covers', 'source_cover_unavailable');
      continue;
    }
    const sourceUrl = safeSourceUrl(`https://covers.openlibrary.org/b/id/${cover}-L.jpg`, ['covers.openlibrary.org']);
    const asset: DeferredCover = {
      sourceUrl,
      credit: {
        rightsHolder: '(c) rights holder',
        via: { name: 'Open Library', url: recordUrl },
        license: 'LicenseRef-unknown',
        obligations: [],
      },
      provenance: { ...envelope('cover'), field_group: 'cover', references: [reference] },
    };
    coverAssets.push(asset);
    if (context.subjectId !== undefined) {
      const intent: MediaImportRequest = { containerId: context.subjectId, ...asset };
      if (checkMediaImportRequest(intent).length) invalid('', 'invalid_media_import_context');
      mediaImportIntents.push(intent);
      const media = context.mediaIds?.[sourceUrl];
      if (media !== undefined) propose(fact('schema:image', media), `cover:${cover}:${media}`, 'cover');
    }
  }
  if (proposals.length > 100) invalid('', 'source_command_limit_100');
  if (checkBatchWrite({ commands: proposals }).length) invalid('', 'invalid_portable_source_proposals');
  return {
    ...metadata,
    source: 'openlibrary',
    outcome: 'converted',
    proposals,
    diagnostics,
    digest,
    normalizedRecord: record,
    coverAssets,
    mediaImportIntents,
    sourceMetadata: {
      subjectType,
      recordUrl,
      bibliographyPermission: 'CC0-1.0',
      ...(record.description === undefined
        ? {}
        : {
            description: { text: record.description, license: 'LicenseRef-unknown', field_group: 'summary' } as const,
          }),
      cover: { role: 'cover', takedownEligible: true },
    },
  };
}
