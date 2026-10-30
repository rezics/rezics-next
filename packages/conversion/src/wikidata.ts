import { types as utilTypes } from 'node:util';
import { bundledRelease } from '@rezics/definitions/bundled';
import { checkBatchWrite, type BatchCommand, type BatchReference, type BatchStatement } from '@rezics/definitions/bulk';
import type { PropertyDefinition } from '@rezics/definitions';
import { ConversionError, type ConversionInput, type ConvertedRecord, type ConversionDiagnostic } from './index';
import {
  canonicalLanguageTag,
  commandKey,
  labelLanguageTag,
  safeSourceUrl,
  sourceDigest,
  sourceEnvelope,
  type ConversionContext,
} from './support';

export const converter_revision = 'wikidata-4';
export const wikidataLimits = Object.freeze({
  bytes: 128 * 1024,
  statements: 64,
  terms: 64,
  references: 15,
  snaks: 16,
  commands: 100,
});

type ObjectValue = Record<string, unknown>;
type Snak = { snaktype: string; property: string; datatype: string; datavalue?: { type: string; value: unknown } };
type Claim = {
  id?: string;
  type: string;
  rank: string;
  mainsnak: Snak;
  qualifiers?: Record<string, Snak[]>;
  references?: { snaks: Record<string, Snak[]> }[];
};
const qualificationLoss = new WeakSet<Claim>();
type Term = { language: string; value: string };
type NormalizedEntity = {
  id: string;
  type: string;
  lastrevid?: number;
  labels: Record<string, Term>;
  aliases: Record<string, Term[]>;
  descriptions: Record<string, Term>;
  claims: Record<string, Claim[]>;
};
export type WikidataConversion = ConvertedRecord<BatchCommand> & {
  outcome: 'converted' | 'ignored';
  digest: string;
  normalizedRecord: NormalizedEntity;
  assets: readonly [];
  sourceMetadata: { license: 'CC0-1.0'; attribution: string; url: string };
};

// Mapping and value validation both come from the shipped catalogue, never from source extensions.
const properties = Object.entries(bundledRelease.properties);
const mappings = new Map(
  properties.flatMap(([id, definition]) =>
    definition.mappings
      .filter((mapping) => /^wd:P[1-9][0-9]*$/.test(mapping))
      .map((mapping) => [mapping.slice(3), { id, definition }] as const),
  ),
);
function exactQuantity(definition: PropertyDefinition): boolean {
  if (definition.datatype !== 'quantity') return false;
  const value = definition.value as {
    type?: unknown;
    required?: unknown;
    properties?: Record<string, unknown>;
    additionalProperties?: unknown;
  };
  return (
    value.type === 'object' &&
    value.additionalProperties === false &&
    Array.isArray(value.required) &&
    value.required.length === 2 &&
    value.required.includes('amount') &&
    value.required.includes('unit') &&
    !!value.properties &&
    Object.keys(value.properties).length === 2 &&
    Object.hasOwn(value.properties, 'amount') &&
    Object.hasOwn(value.properties, 'unit') &&
    !Object.hasOwn(value.properties, 'lowerBound') &&
    !Object.hasOwn(value.properties, 'upperBound')
  );
}
const types = new Map(
  Object.entries(bundledRelease.types).flatMap(([id, definition]) =>
    definition.mappings.map((mapping) => [mapping.replace(/^wd:/, ''), id] as const),
  ),
);
const claimProperties = [...new Set(['P31', ...mappings.keys()])];
const referenceProperties = [...new Set(['P854', ...mappings.keys()])];
const qid = /^Q[1-9][0-9]{0,15}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const fail: (code: string, pointer?: string) => never = (code, pointer = '') => {
  throw new ConversionError(code, pointer);
};
const dictionary = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;

/** Reads only data properties; unknown fields and their accessors are never evaluated. */
function object(value: unknown, pointer: string): ObjectValue {
  if (
    !value ||
    typeof value !== 'object' ||
    utilTypes.isProxy(value) ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    fail('Expected a plain source object', pointer);
  return value as ObjectValue;
}
function get(value: ObjectValue, key: string, pointer: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return undefined;
  if (!('value' in descriptor)) fail('Source accessors are unsupported', pointer);
  return descriptor.value;
}
function list(value: unknown, limit: number, pointer: string): unknown[] {
  if (
    utilTypes.isProxy(value) ||
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > limit
  )
    fail('Source array exceeds its field limit or is malformed', pointer);
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !('value' in descriptor)) fail('Source array must contain data entries', pointer);
  }
  return value;
}
function text(value: unknown, pointer: string, limit = 1500): string {
  if (typeof value !== 'string' || !value.isWellFormed() || !value.length || value.length > limit)
    fail('Source string is malformed or exceeds its byte/field budget', pointer);
  return value;
}
function url(value: unknown, pointer: string): string {
  const candidate = text(value, pointer);
  if (/[\u0000-\u0020\u007f-\u009f\\]/u.test(candidate) || !/^https?:\/\//.test(candidate))
    fail('Unsafe source URL', pointer);
  try {
    const parsed = new URL(candidate);
    if (!parsed.hostname || parsed.username || parsed.password) fail('Unsafe source URL', pointer);
  } catch {
    fail('Unsafe source URL', pointer);
  }
  return candidate;
}

export function convertWikidata(
  input: ConversionInput,
  context: ConversionContext = {},
  options: { readonly converterRevision?: string } = {},
): WikidataConversion {
  const diagnostics: ConversionDiagnostic[] = [];
  let scalarBytes = 0;
  let statementCount = 0;
  let termCount = 0;
  const read = (value: ObjectValue, key: string, pointer: string) => {
    const field = get(value, key, pointer);
    if (typeof field === 'string') {
      scalarBytes += Buffer.byteLength(field, 'utf8');
      if (scalarBytes > wikidataLimits.bytes) fail('Source record exceeds 128 KiB', pointer);
    }
    return field;
  };
  const diagnose = (code: string, pointer: string) => {
    diagnostics.push({ code, pointer });
  };
  const raw = object(input.record, '');
  const id = text(read(raw, 'id', '/id'), '/id', 255);
  if (!qid.test(id) || id !== input.external_id) fail('Invalid or mismatched Wikidata entity ID', '/id');
  if (read(raw, 'type', '/type') !== 'item') fail('Expected a Wikidata item entity', '/type');
  const revision = read(raw, 'lastrevid', '/lastrevid');
  if (revision !== undefined && (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1))
    fail('Invalid Wikidata entity revision', '/lastrevid');
  const record_revision = revision === undefined ? 'unversioned' : String(revision);
  if (input.record_revision !== record_revision) fail('Source envelope revision does not match entity', '/lastrevid');
  const registeredRevision = options.converterRevision ?? converter_revision;
  const sourceId = context.source === undefined ? 'wikidata' : context.source;
  if (typeof registeredRevision !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(registeredRevision))
    fail('Invalid registered converter revision');
  if (context.subjectId !== undefined && !uuid.test(context.subjectId)) fail('Invalid resolved subject UUID');

  // Count and read only the platform projection. Rejected keys are never read, so
  // they cannot trip the term cap, the byte budget, or record validation.
  function terms(key: 'labels' | 'aliases' | 'descriptions') {
    const pointer = `/${key}`;
    const value = read(raw, key, pointer);
    const result = dictionary<Term | Term[]>();
    if (value === undefined) return result;
    const map = object(value, pointer);
    const seen = new Set<string>();
    for (const lang of Object.keys(map)) {
      const canonical = labelLanguageTag(lang);
      if (canonical === null) continue;
      if (seen.has(canonical)) {
        diagnose('Duplicate canonical term language; kept the first source key', `${pointer}/${lang}`);
        continue;
      }
      if (seen.size === wikidataLimits.terms) fail('Source term limit exceeded', pointer);
      seen.add(canonical);
      const term = read(map, lang, pointer);
      const convert = (entry: unknown): Term => {
        if (++termCount > wikidataLimits.terms) fail('Source term limit exceeded', pointer);
        const body = object(entry, pointer);
        if (read(body, 'language', pointer) !== lang) fail('Source term language mismatch', pointer);
        return { language: canonical, value: text(read(body, 'value', pointer), pointer) };
      };
      result[canonical] = key === 'aliases' ? list(term, wikidataLimits.terms, pointer).map(convert) : convert(term);
    }
    return result;
  }

  function snak(
    entry: unknown,
    property: string,
    pointer: string,
    preserveUnsupportedMonolingual = false,
  ): Snak | undefined {
    const body = object(entry, pointer);
    if (read(body, 'property', pointer) !== property) fail('Mismatched mainsnak property', pointer);
    const snaktype = read(body, 'snaktype', pointer);
    if (!['value', 'somevalue', 'novalue'].includes(snaktype as string)) fail('Invalid snak type', pointer);
    const datatype = text(read(body, 'datatype', pointer), pointer, 64);
    const result: Snak = { snaktype: snaktype as string, property, datatype };
    const expected =
      property === 'P31' ? 'wikibase-item' : property === 'P854' ? 'url' : mappings.get(property)!.definition.datatype;
    if (datatype !== expected) fail('Mapped snak datatype mismatch', pointer);
    if (snaktype !== 'value') return result;
    const data = object(read(body, 'datavalue', pointer), pointer);
    const kind = text(read(data, 'type', pointer), pointer, 64);
    const value = read(data, 'value', pointer);
    let projection: unknown;
    if (datatype === 'wikibase-item') {
      const entity = object(value, pointer);
      const target = text(read(entity, 'id', pointer), pointer, 255);
      const entityType = read(entity, 'entity-type', pointer);
      const numericId = read(entity, 'numeric-id', pointer);
      if (
        kind !== 'wikibase-entityid' ||
        !qid.test(target) ||
        entityType !== 'item' ||
        typeof numericId !== 'number' ||
        !Number.isSafeInteger(numericId) ||
        String(numericId) !== target.slice(1)
      )
        fail('Invalid Wikidata relation identity', pointer);
      projection = { 'entity-type': 'item', 'numeric-id': numericId, id: target };
    } else if (datatype === 'time') {
      if (kind !== 'time') fail('Invalid date datavalue', pointer);
      const date = object(value, pointer);
      const copy = dictionary<unknown>();
      for (const key of ['time', 'timezone', 'before', 'after', 'precision', 'calendarmodel']) {
        const item = read(date, key, pointer);
        if (key === 'time' || key === 'calendarmodel') copy[key] = text(item, pointer);
        else {
          if (typeof item !== 'number' || !Number.isSafeInteger(item)) fail('Malformed Wikidata date', pointer);
          copy[key] = item;
        }
      }
      if (
        !/^[+-][0-9]{4,16}-[0-9]{2}-[0-9]{2}T00:00:00Z$/.test(copy.time as string) ||
        !/^http:\/\/www.wikidata.org\/entity\/Q[1-9][0-9]*$/.test(copy.calendarmodel as string)
      )
        fail('Malformed Wikidata date or calendar URL', pointer);
      projection = copy;
    } else if (datatype === 'quantity') {
      if (kind !== 'quantity') fail('Invalid quantity datavalue', pointer);
      const quantity = object(value, pointer);
      const copy = dictionary<unknown>();
      for (const key of ['amount', 'unit', 'lowerBound', 'upperBound']) {
        const part = read(quantity, key, pointer);
        if (part !== undefined) copy[key] = text(part, pointer);
      }
      if (
        typeof copy.amount !== 'string' ||
        !/^[+-](?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(copy.amount) ||
        typeof copy.unit !== 'string'
      )
        fail('Malformed Wikidata quantity', pointer);
      projection = copy;
    } else if (datatype === 'monolingualtext') {
      if (kind !== 'monolingualtext') fail('Invalid monolingual datavalue', pointer);
      const term = object(value, pointer);
      const rawLanguage = read(term, 'language', pointer);
      if (typeof rawLanguage !== 'string' || !rawLanguage.isWellFormed()) fail('Invalid monolingual language', pointer);
      const lang = canonicalLanguageTag(rawLanguage);
      // No canonical tag writes no value. Leave the text unread so it cannot fail the record.
      if (lang === null) {
        diagnose('Monolingual text has no canonical language tag', pointer);
        if (!preserveUnsupportedMonolingual) return undefined;
        projection = { language: rawLanguage };
      } else {
        projection = { language: lang, text: text(read(term, 'text', pointer), pointer) };
      }
    } else {
      if (kind !== 'string') fail('Invalid string datavalue', pointer);
      projection = datatype === 'url' ? url(value, pointer) : text(value, pointer);
    }
    result.datavalue = { type: kind, value: projection };
    return result;
  }

  // Iterate the fixed supported vocabulary rather than traversing unknown property bodies.
  function snaks(value: unknown, reference: boolean, pointer: string, exact = false) {
    const body = object(value, pointer);
    const result = dictionary<Snak[]>();
    let count = 0;
    let omitted = false;
    const supported = reference ? referenceProperties : mappings.keys();
    const supportedSet = new Set(supported);
    if (exact && !reference) {
      for (const property in body) {
        if (!Object.hasOwn(body, property) || supportedSet.has(property)) continue;
        omitted = true;
        // Retain one actual unknown qualifier key, but never its body. This
        // bounded marker survives normalization/serialization so a second
        // conversion cannot publish the amount after losing its qualifier.
        result[property] = [];
        break;
      }
    }
    for (const property of supportedSet) {
      const entries = read(body, property, pointer);
      if (entries === undefined) continue;
      const items = list(entries, wikidataLimits.snaks, pointer);
      count += items.length;
      if (count > wikidataLimits.snaks) fail('Source snak limit exceeded', pointer);
      result[property] = items.flatMap((item) => {
        const parsed = snak(item, property, pointer, exact && !reference);
        if (parsed === undefined) {
          if (exact && !reference) omitted = true;
          return [];
        }
        return [parsed];
      });
    }
    return { result, omitted };
  }

  const normalizedRecord: NormalizedEntity = {
    id,
    type: 'item',
    ...(revision === undefined ? {} : { lastrevid: revision as number }),
    labels: terms('labels') as Record<string, Term>,
    aliases: terms('aliases') as Record<string, Term[]>,
    descriptions: terms('descriptions') as Record<string, Term>,
    claims: dictionary<Claim[]>(),
  };
  const claims = object(read(raw, 'claims', '/claims'), '/claims');
  for (const property of claimProperties) {
    const value = read(claims, property, '/claims');
    if (value === undefined) continue;
    const pointer = `/claims/${property}`;
    const entries = list(value, wikidataLimits.statements, pointer);
    statementCount += entries.length;
    if (statementCount > wikidataLimits.statements) fail('Source statement limit exceeded', '/claims');
    const kept: Claim[] = [];
    for (const entry of entries) {
      const body = object(entry, pointer);
      const rank = read(body, 'rank', pointer);
      if (
        !['normal', 'preferred', 'deprecated'].includes(rank as string) ||
        read(body, 'type', pointer) !== 'statement'
      )
        fail('Malformed Wikidata statement or rank', pointer);
      const main = snak(read(body, 'mainsnak', pointer), property, pointer);
      if (main === undefined) continue;
      const result: Claim = { type: 'statement', rank: rank as string, mainsnak: main };
      const claimId = read(body, 'id', pointer);
      if (claimId !== undefined) {
        result.id = text(claimId, pointer, 255);
        if (!new RegExp(`^${id}\\$[0-9a-fA-F-]{36}$`).test(result.id)) fail('Invalid Wikidata statement ID', pointer);
      }
      const qualifiers = read(body, 'qualifiers', pointer);
      if (qualifiers !== undefined) {
        const projected = snaks(qualifiers, false, pointer, exactQuantity(mappings.get(property)!.definition));
        result.qualifiers = projected.result;
        if (projected.omitted) qualificationLoss.add(result);
      }
      const references = read(body, 'references', pointer);
      if (references !== undefined)
        result.references = list(references, wikidataLimits.references, pointer).map((referenceEntry) => {
          const reference = object(referenceEntry, pointer);
          return { snaks: snaks(read(reference, 'snaks', pointer), true, pointer).result };
        });
      kept.push(result);
    }
    if (kept.length) normalizedRecord.claims[property] = kept;
  }
  const inputBytes = Buffer.byteLength(JSON.stringify(normalizedRecord), 'utf8');
  if (inputBytes > wikidataLimits.bytes) fail('Source record exceeds 128 KiB');
  const digest = sourceDigest(normalizedRecord);
  const meta = { source: sourceId, external_id: id, record_revision, converter_revision: registeredRevision, digest };
  const source = sourceEnvelope(meta, 'facts');
  const sourceUrl = safeSourceUrl(
    `https://www.wikidata.org/wiki/${id}${revision === undefined ? '' : `?oldid=${record_revision}`}`,
    ['www.wikidata.org'],
  );
  const sourceMetadata = { license: 'CC0-1.0' as const, attribution: 'Wikidata contributors', url: sourceUrl };
  const part = (property: string, content: unknown): BatchReference['parts'][number] => ({
    property: { id: property },
    value: { type: 'value', content },
  });
  const citation = (target?: string): BatchReference => ({
    parts: [
      part('schema:url', sourceUrl),
      ...(target ? [part('schema:sameAs', `http://www.wikidata.org/entity/${target}`)] : []),
    ],
  });

  function valueOf(snak: Snak, definition: PropertyDefinition, pointer: string): BatchStatement['value'] | undefined {
    if (snak.snaktype !== 'value') return { type: snak.snaktype as 'somevalue' | 'novalue' };
    let content = snak.datavalue!.value;
    if (definition.datatype === 'wikibase-item') {
      const target = (content as { id: string }).id;
      const resolutions = context.resolvedReferences;
      const resolved = resolutions && Object.hasOwn(resolutions, target) ? resolutions[target] : undefined;
      if (resolved === undefined) return { type: 'somevalue' };
      if (typeof resolved !== 'string' || !uuid.test(resolved)) fail('Invalid resolved relation UUID', pointer);
      content = resolved;
    } else if (definition.datatype === 'time') {
      const date = content as {
        time: string;
        precision: number;
        calendarmodel: string;
        timezone: number;
        before: number;
        after: number;
      };
      if (
        ![9, 10, 11].includes(date.precision) ||
        date.calendarmodel !== 'http://www.wikidata.org/entity/Q1985727' ||
        date.timezone !== 0 ||
        date.before !== 0 ||
        date.after !== 0
      ) {
        diagnose('Unsupported date precision, uncertainty, timezone or calendar', pointer);
        return;
      }
      const pieces = /^[+-]([0-9]+)-([0-9]{2})-([0-9]{2})/.exec(date.time)!;
      const year = Number(pieces[1]),
        month = Number(pieces[2]),
        day = Number(pieces[3]);
      const days = [
        31,
        year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
      ];
      if (
        date.precision === 9
          ? month !== 0 || day !== 0
          : month < 1 || month > 12 || (date.precision === 10 ? day !== 0 : day < 1 || day > days[month - 1]!)
      )
        fail('Invalid source calendar date', pointer);
      content = { time: date.time, precision: date.precision, calendarmodel: date.calendarmodel };
    } else if (definition.datatype === 'monolingualtext') {
      const term = content as { language?: unknown; text?: unknown };
      const language = typeof term.language === 'string' ? canonicalLanguageTag(term.language) : null;
      if (language === null || typeof term.text !== 'string') {
        diagnose('Unsupported monolingual qualifier value', pointer);
        return;
      }
      content = { language, text: term.text };
    } else if (definition.datatype === 'quantity') {
      const quantity = content as { amount: string; unit: string; lowerBound?: string; upperBound?: string };
      if (quantity.lowerBound !== undefined || quantity.upperBound !== undefined) {
        diagnose('Unsupported quantity uncertainty', pointer);
        return;
      }
      content = { amount: quantity.amount, unit: quantity.unit };
    }
    // Enforce source scalar constraints from the actual bundled property definition.
    const scalar = definition.value as { pattern?: string };
    if (typeof content === 'string' && scalar.pattern && new RegExp(scalar.pattern, 'u').exec(content)?.[0] !== content)
      fail('Source value violates the mapped catalogue datatype', pointer);
    if (definition.datatype === 'quantity' && (definition.minimum !== undefined || definition.maximum !== undefined)) {
      const quantity = content as { amount: string; unit: string };
      const schema = definition.value as { properties: { amount: { pattern: string } } };
      if (
        !new RegExp(schema.properties.amount.pattern).test(quantity.amount) ||
        !definition.units?.includes(quantity.unit)
      )
        fail('Source quantity violates its mapped datatype or units', pointer);
      const amount = Number((content as { amount: string }).amount);
      if (
        !Number.isFinite(amount) ||
        amount < (definition.minimum ?? -Infinity) ||
        amount > (definition.maximum ?? Infinity)
      )
        fail('Source quantity violates catalogue bounds', pointer);
    }
    return { type: 'value', content };
  }

  let subjectType: string | undefined;
  for (const claim of normalizedRecord.claims.P31 ?? []) {
    if (claim.rank === 'deprecated' || claim.mainsnak.snaktype !== 'value') continue;
    const target = (claim.mainsnak.datavalue!.value as { id: string }).id;
    const mapped = types.get(target);
    if (mapped && subjectType && subjectType !== mapped) fail('Ambiguous mapped Wikidata entity types', '/claims/P31');
    if (mapped) subjectType = mapped;
  }
  const statements: BatchStatement[] = Object.values(normalizedRecord.labels).map((term) => ({
    property: { id: 'schema:name' },
    value: { type: 'value', content: { language: term.language, text: term.value } },
    references: [citation()],
  }));
  for (const [property, entries] of Object.entries(normalizedRecord.claims)) {
    if (property === 'P31') continue;
    const { id: mapped, definition } = mappings.get(property)!;
    const pointer = `/claims/${property}`;
    for (const claim of entries) {
      if (claim.rank === 'deprecated') {
        diagnose('Deprecated source statement skipped', pointer);
        continue;
      }
      const relation = definition.datatype === 'wikibase-item';
      const exact = exactQuantity(definition);
      let lostQualifier = qualificationLoss.has(claim);
      if (lostQualifier) diagnose('Exact quantity has an unmapped qualifier', pointer);
      if (relation && claim.mainsnak.snaktype !== 'value') {
        diagnose('Relation has no source identity', pointer);
        continue;
      }
      const target = relation ? (claim.mainsnak.datavalue!.value as { id: string }).id : undefined;
      const value = valueOf(claim.mainsnak, definition, pointer);
      if (!value) continue;
      const qualifiers: NonNullable<BatchStatement['qualifiers']> = [];
      for (const [key, snaks] of Object.entries(claim.qualifiers ?? {})) {
        const qualifier = mappings.get(key);
        if (!qualifier) {
          diagnose('Exact quantity has an unmapped qualifier', pointer);
          if (exact) lostQualifier = true;
          continue;
        }
        if (!definition.qualifiers.includes(qualifier.id)) {
          diagnose('Qualifier is unsupported by the mapped property', pointer);
          if (exact) lostQualifier = true;
          continue;
        }
        for (const snak of snaks) {
          if (qualifier.definition.datatype === 'wikibase-item') {
            diagnose('Item qualifier is unsupported', pointer);
            if (exact) lostQualifier = true;
            continue;
          }
          const value = valueOf(snak, qualifier.definition, pointer);
          if (!value) {
            if (exact) lostQualifier = true;
            continue;
          }
          if (exact && value.type === 'somevalue') {
            diagnose('Exact quantity qualifier has no resolved value', pointer);
            lostQualifier = true;
            continue;
          }
          if (value)
            qualifiers.push(
              value.type === 'value' ? part(qualifier.id, value.content) : { property: { id: qualifier.id }, value },
            );
        }
      }
      if (exact && lostQualifier) continue;
      if (target && value.type === 'somevalue') {
        if (!definition.qualifiers.includes('schema:sameAs')) {
          diagnose('Unresolved relation lacks an approved identity qualifier', pointer);
          continue;
        }
        qualifiers.push(part('schema:sameAs', `http://www.wikidata.org/entity/${target}`));
        diagnose('Unresolved Wikidata relation', pointer);
      }
      const references: BatchReference[] = [citation(target)];
      for (const reference of claim.references ?? []) {
        const parts: BatchReference['parts'] = [];
        for (const [key, snaks] of Object.entries(reference.snaks)) {
          for (const snak of snaks) {
            if (key === 'P854') {
              if (snak.snaktype === 'value') parts.push(part('schema:url', snak.datavalue!.value));
              continue;
            }
            const mapping = mappings.get(key)!;
            if (mapping.definition.datatype === 'wikibase-item') {
              if (snak.snaktype === 'value')
                parts.push(
                  part(
                    'schema:sameAs',
                    `http://www.wikidata.org/entity/${(snak.datavalue!.value as { id: string }).id}`,
                  ),
                );
            } else {
              const value = valueOf(snak, mapping.definition, pointer);
              if (value)
                parts.push(
                  value.type === 'value' ? part(mapping.id, value.content) : { property: { id: mapping.id }, value },
                );
            }
          }
        }
        if (parts.length) references.push({ parts });
      }
      statements.push({
        property: { id: mapped },
        value,
        rank: claim.rank as 'normal' | 'preferred',
        ...(qualifiers.length ? { qualifiers } : {}),
        references,
      });
    }
  }
  const proposals: BatchCommand[] = [];
  if (!subjectType) diagnose('Unsupported Wikidata entity type', '/claims/P31');
  else if (context.subjectId) {
    statements.forEach((statement, index) =>
      proposals.push({
        op: 'propose',
        subject: context.subjectId!,
        source,
        statement,
        key: commandKey([sourceId, id, record_revision, registeredRevision, digest, context.subjectId!, String(index)]),
      }),
    );
  } else {
    const termValues = (terms: Record<string, Term>) =>
      Object.fromEntries(Object.entries(terms).map(([key, term]) => [key, term.value]));
    proposals.push({
      op: 'create',
      source,
      key: commandKey([sourceId, id, record_revision, registeredRevision, digest, 'bootstrap']),
      subject: {
        type: subjectType,
        labels: termValues(normalizedRecord.labels),
        aliases: Object.fromEntries(
          Object.entries(normalizedRecord.aliases).map(([key, terms]) => [key, terms.map((term) => term.value)]),
        ),
        descriptions: termValues(normalizedRecord.descriptions),
      },
    });
  }
  if (proposals.length > wikidataLimits.commands) fail('Converted command limit exceeded');
  if (proposals.length && checkBatchWrite({ commands: proposals }).length)
    fail('Converted proposals violate the portable bulk contract');
  return {
    ...meta,
    source: 'wikidata',
    outcome: proposals.length ? 'converted' : 'ignored',
    proposals,
    digest,
    normalizedRecord,
    diagnostics,
    assets: [],
    sourceMetadata,
  };
}
