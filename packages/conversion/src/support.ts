import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import { FIELD_GROUPS, SourceSchema, type FieldGroup, type Source } from '@rezics/definitions/bulk';
import { documentVersion, normalizeDocument, serializeDocument, type DocumentSnapshot } from '@rezics/document';

/** Immutable caller configuration; resolutions and media IDs confer no authority. */
export type ConversionContext = {
  readonly subjectId?: string;
  readonly resolvedReferences?: Readonly<Record<string, string>>;
  readonly mediaIds?: Readonly<Record<string, string>>;
  readonly source?: string;
};

/** Canonical BCP 47 syntax, without source-specific language mappings. */
export function canonicalLanguageTag(tag: string): string | null {
  if (tag.length === 0 || tag.length > 64) return null;
  try {
    return Intl.getCanonicalLocales(tag)[0] ?? null;
  } catch {
    return null;
  }
}

const inLanguagePattern = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|[0-9]{3}))?$/;

/** Semantic language values permit only language, script and region. */
export function inLanguageTag(tag: string): string | null {
  const canonical = canonicalLanguageTag(tag);
  return canonical !== null && canonical !== 'und' && inLanguagePattern.test(canonical) ? canonical : null;
}

const marcLanguageReplacements: Readonly<Record<string, string | null>> = Object.freeze({
  // ISO 639-2 bibliographic codes need terminology equivalents before Intl.
  alb: 'sqi',
  arm: 'hye',
  baq: 'eus',
  bur: 'mya',
  chi: 'zho',
  cze: 'ces',
  dut: 'nld',
  fre: 'fra',
  geo: 'kat',
  ger: 'deu',
  gre: 'ell',
  ice: 'isl',
  mac: 'mkd',
  mao: 'mri',
  may: 'msa',
  per: 'fas',
  rum: 'ron',
  slo: 'slk',
  tib: 'bod',
  wel: 'cym',
  // All discontinued codes in the Library of Congress MARC Code List:
  // https://www.loc.gov/marc/languages/language_code.html
  // Replacements: https://www.loc.gov/marc/isochange_ann.html
  // Later changes: https://www.loc.gov/marc/languages/languagechg.html
  // Aljamía has no language replacement; Eskimo languages split into several codes.
  ajm: null,
  cam: 'khm',
  esk: null,
  esp: 'epo',
  eth: 'gez',
  far: 'fao',
  fri: 'fry',
  gae: 'gla',
  gag: 'glg',
  gal: 'orm',
  gua: 'grn',
  int: 'ina',
  iri: 'gle',
  kus: 'kos',
  lan: 'oci',
  lap: 'smi',
  max: 'glv',
  mla: 'mlg',
  mol: 'ron', // MARC replacement rum, expressed as its terminology equivalent.
  sao: 'smo',
  scc: 'srp',
  scr: 'hrv',
  sho: 'sna',
  snh: 'sin',
  sso: 'sot',
  swz: 'ssw',
  tag: 'tgl',
  taj: 'tgk',
  tar: 'tat',
  tru: 'chk',
  tsw: 'tsn',
});

/** Open Library language identifiers contain lowercase three-letter MARC codes. */
export function marcLanguageTag(code: string): string | null {
  if (code.length !== 3 || !/^[a-z]{3}$/.test(code)) return null;
  const replacement = marcLanguageReplacements[code];
  return replacement === null ? null : inLanguageTag(replacement ?? code);
}

/** Keep this literal aligned with the shipped presentation/core locale files. */
export const platformLabelLanguages: readonly string[] = Object.freeze([
  'de', 'en', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant',
]);

const platformLabelPrimaryLanguages = new Set(platformLabelLanguages.map((tag) => tag.split('-')[0]!));

/** Labels retain platform language families and the multilingual default. */
export function labelLanguageTag(tag: string): string | null {
  const canonical = canonicalLanguageTag(tag);
  return canonical !== null && (canonical === 'mul' || platformLabelPrimaryLanguages.has(canonical.split('-')[0]!))
    ? canonical
    : null;
}

// Match the importer's default record budget. No catalogue/history state is retained.
const recordBytes = 2 * 1024 * 1024;
const documentBytes = 32 * 1024;
const hash = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** Copy data descriptors once, before canonicalize can invoke any input hooks. */
function jsonSnapshot(input: unknown): unknown {
  let result: unknown;
  let bytes = 0;
  const charge = (size: number) => {
    bytes += size;
    if (bytes > recordBytes) throw new RangeError('Source projection exceeds 2 MiB');
  };
  const stringBytes = (value: string): number => {
    if (!value.isWellFormed()) throw new TypeError('JSON strings must contain valid Unicode');
    if (value.length > recordBytes) throw new RangeError('Source string exceeds 2 MiB');
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  };
  type Work = { value: unknown; put: (value: unknown) => void } | { leave: object };
  const ancestors = new Set<object>();
  const stack: Work[] = [{ value: input, put: (value) => { result = value; } }];
  while (stack.length) {
    const work = stack.pop()!;
    if ('leave' in work) { ancestors.delete(work.leave); continue; }
    const { value, put } = work;
    if (value === null || typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number') {
      if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('Nonfinite JSON number');
      charge(typeof value === 'string' ? stringBytes(value) : JSON.stringify(value).length);
      put(value);
      continue;
    }
    if (typeof value !== 'object') throw new TypeError('Expected a JSON value');
    if (ancestors.has(value)) throw new TypeError('Circular JSON value');
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
      throw new TypeError('Expected a plain JSON container');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    const length = array ? descriptors.length!.value as number : 0;
    if (array && keys.length !== length + 1) throw new TypeError('Sparse or extended JSON array');
    charge(2 + Math.max(0, keys.length - (array ? 1 : 0) - 1));
    const copy: Record<string, unknown> = array ? [] : Object.create(null);
    put(copy);
    ancestors.add(value);
    stack.push({ leave: value });
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string') throw new TypeError('Symbol JSON key');
      const descriptor = descriptors[key]!;
      if (!descriptor.enumerable || !('value' in descriptor)) throw new TypeError('Expected enumerable JSON data');
      if (array) {
        const index = Number(key);
        if (!Number.isInteger(index) || index < 0 || index >= length || String(index) !== key)
          throw new TypeError('Extended JSON array');
      } else charge(stringBytes(key) + 1);
      stack.push({ value: descriptor.value, put: (child) => { copy[key] = child; } });
    }
  }
  return result;
}

/** Callers must whitelist source fields first, excluding converter/target binding data. */
export function sourceDigest(normalizedProjection: unknown): string {
  const text = canonicalize(jsonSnapshot(normalizedProjection));
  if (text === undefined) throw new TypeError('Expected a JSON projection');
  return hash(text);
}

export function sourceEnvelope(
  meta: { source: string; external_id: string; record_revision: string | null; converter_revision: string; digest: string },
  fieldGroup: FieldGroup,
): Source {
  const source: Source = {
    source: meta.source,
    external_id: meta.external_id,
    record_revision: meta.record_revision === null ? 'unversioned' : meta.record_revision,
    converter_revision: meta.converter_revision,
    digest: meta.digest,
    field_group: fieldGroup,
  };
  // Use the portable schema as the authority for sizes and formats.
  for (const key of ['source', 'external_id', 'record_revision', 'converter_revision', 'digest'] as const) {
    const rule = SourceSchema.properties[key] as { minLength?: number; maxLength?: number; pattern?: string };
    const value = source[key];
    if (typeof value !== 'string' || value.length < (rule.minLength ?? 0) || value.length > (rule.maxLength ?? Infinity) ||
      (rule.pattern !== undefined && new RegExp(rule.pattern, 'u').exec(value)?.[0] !== value))
      throw new TypeError(`Invalid source ${key}`);
  }
  if (!FIELD_GROUPS.includes(fieldGroup)) throw new TypeError('Invalid source field_group');
  return source;
}

/** Hash an unambiguous bounded JSON tuple once; never use randomness or time. */
export function commandKey(parts: readonly string[]): string {
  const snapshot = jsonSnapshot(parts);
  if (!Array.isArray(snapshot) || !snapshot.every((part) => typeof part === 'string'))
    throw new TypeError('Command key parts must be strings');
  return hash(canonicalize(snapshot)!);
}

/** Syntax only; the fetching service must also validate resolved addresses and redirects. */
export function safeSourceUrl(url: unknown, hosts: readonly string[]): string {
  if (typeof url !== 'string' || !url.isWellFormed() || Buffer.byteLength(url, 'utf8') > 2048 ||
    /[\u0000-\u0020\u007f-\u009f\\]/u.test(url) || url.trim() !== url)
    throw new TypeError('Invalid source URL');
  // Inspect the original authority too: URL parsing otherwise hides explicit :443 ports.
  const authority = /^https:\/\/([^/?#]+)(?:[/?#]|$)/u.exec(url)?.[1];
  if (!authority || /[@:%]/u.test(authority)) throw new TypeError('Expected an HTTPS hostname without credentials or port');
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port ||
    authority.toLowerCase() !== parsed.hostname || !hosts.includes(parsed.hostname))
    throw new TypeError('Source hostname is not allowed');
  return parsed.href;
}

/** A literal paragraph preserves CR/LF and Markdown syntax without interpreting either. */
export function textDocument(text: string): DocumentSnapshot {
  if (typeof text !== 'string' || !text.isWellFormed()) throw new TypeError('Expected valid Unicode text');
  if (Buffer.byteLength(text, 'utf8') > documentBytes) throw new RangeError('Text exceeds 32 KiB');
  const snapshot = normalizeDocument({
    version: documentVersion,
    profile: 'text',
    doc: {
      type: 'doc',
      content: [{
        type: 'paragraph',
        attrs: { id: `text-${hash(text)}` },
        ...(text ? { content: [{ type: 'text', text }] } : {}),
      }],
    },
  });
  if (Buffer.byteLength(serializeDocument(snapshot), 'utf8') > documentBytes)
    throw new RangeError('Text snapshot exceeds 32 KiB');
  return snapshot;
}
