import type { PropertyDefinition, Release } from './index.ts';
import { Compile } from 'typebox/schema';
import { checkDocument, serializeDocument } from '@rezics/document';
import spdxLicenseIds from 'spdx-license-ids';

export type Violation = {
  pointer: string;
  code: 'required' | 'unknown_field' | 'invalid_type' | 'invalid_format' | 'out_of_range' | 'unsupported';
};

const languagePattern = /^[a-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/;
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const pointer = (base: string, part: string | number) =>
  `${base}/${String(part).replaceAll('~', '~0').replaceAll('/', '~1')}`;

export function checkSubjectStructure(input: unknown, release?: Release) {
  const errors: Violation[] = [];
  const add = (at: string, code: Violation['code']) => {
    if (errors.length < 16) errors.push({ pointer: at, code });
  };
  const fields = (obj: Record<string, unknown>, allowed: string[], base: string) => {
    for (const key of Object.keys(obj)) if (!allowed.includes(key)) add(pointer(base, key), 'unknown_field');
  };
  if (!isObject(input)) {
    return { violations: [{ pointer: '', code: 'invalid_type' } as Violation], terms: [], aliasTerms: [], drafts: [] };
  }
  fields(input, ['type', 'labels', 'descriptions', 'aliases', 'statements'], '');
  const terms: { kind: 'label' | 'description'; language: string; body: string }[] = [];
  const aliasTerms: { language: string; body: string }[] = [];
  const termMap = (key: 'labels' | 'descriptions' | 'aliases') => {
    const raw = input[key];
    if (raw === undefined) return;
    if (!isObject(raw)) {
      add(`/${key}`, 'invalid_type');
      return;
    }
    for (const [lang, value] of Object.entries(raw)) {
      const at = `/${key}/${lang.replaceAll('~', '~0').replaceAll('/', '~1')}`;
      if (!languagePattern.test(lang)) {
        add(at, 'invalid_format');
        continue;
      }
      if (key === 'aliases') {
        if (!Array.isArray(value)) {
          add(at, 'invalid_type');
          continue;
        }
        if (value.length > 32) add(at, 'out_of_range');
        const seen = new Set<string>();
        value.forEach((item, i) => {
          if (typeof item !== 'string') {
            add(pointer(at, i), 'invalid_type');
            return;
          }
          if (item.length < 1 || item.length > 250 || item.trim() !== item)
            add(pointer(at, i), item.length > 250 ? 'out_of_range' : 'invalid_format');
          if (seen.has(item)) add(pointer(at, i), 'invalid_format');
          seen.add(item);
          aliasTerms.push({ language: lang, body: item });
        });
      } else {
        if (typeof value !== 'string') {
          add(at, 'invalid_type');
          continue;
        }
        if (value.length < 1 || value.length > 250) add(at, value.length > 250 ? 'out_of_range' : 'invalid_format');
        else if (value.trim() !== value) add(at, 'invalid_format');
        terms.push({ kind: key === 'labels' ? 'label' : 'description', language: lang, body: value });
      }
    }
  };
  termMap('labels');
  termMap('descriptions');
  termMap('aliases');
  if (!isObject(input.labels) || Object.keys(input.labels).length === 0) add('/labels', 'required');

  type StatementDraft = {
    property: string;
    rank: string;
    value: unknown;
    qualifiers: unknown[];
    references: { parts: unknown[] }[];
  };
  const drafts: { property: string; entries: StatementDraft[] }[] = [];
  const validateSnak = (raw: unknown, at: string, expected?: string): unknown => {
    if (!isObject(raw)) {
      add(at, 'invalid_type');
      return null;
    }
    fields(raw, ['property', 'value'], at);
    if (!isObject(raw.property)) {
      add(`${at}/property`, 'invalid_type');
      return null;
    }
    fields(raw.property, ['id'], `${at}/property`);
    const id = raw.property.id;
    if (typeof id !== 'string') {
      add(`${at}/property/id`, 'invalid_type');
      return null;
    }
    if (expected && id !== expected) add(`${at}/property/id`, 'invalid_format');
    const val = raw.value;
    if (!isObject(val) || typeof val.type !== 'string' || !['value', 'somevalue', 'novalue'].includes(val.type)) {
      add(`${at}/value`, 'invalid_format');
      return null;
    }
    fields(val, val.type === 'value' ? ['type', 'content'] : ['type'], `${at}/value`);
    if (val.type === 'value') {
      if (!own(val, 'content')) add(`${at}/value/content`, 'required');
      else if (val.content === undefined) add(`${at}/value/content`, 'invalid_type');
    } else if (own(val, 'content')) add(`${at}/value/content`, 'unknown_field');
    if (val.type === 'value')
      for (const error of valueLimits(val.content, `${at}/value/content`)) add(error.pointer, error.code);
    return { property: id, value: val };
  };
  if (input.statements !== undefined) {
    if (!isObject(input.statements)) add('/statements', 'invalid_type');
    else
      for (const [prop, list] of Object.entries(input.statements)) {
        const at = `/statements/${prop.replaceAll('~', '~0').replaceAll('/', '~1')}`;
        if (!Array.isArray(list)) {
          add(at, 'invalid_type');
          continue;
        }
        const entries: StatementDraft[] = [];
        list.forEach((entry, i) => {
          const path = pointer(at, i);
          if (!isObject(entry)) {
            add(path, 'invalid_type');
            return;
          }
          fields(entry, ['property', 'value', 'rank', 'qualifiers', 'references'], path);
          const snak = validateSnak({ property: entry.property, value: entry.value }, path, prop) as {
            property: string;
            value: unknown;
          } | null;
          const rank = entry.rank === undefined ? 'normal' : entry.rank;
          if (typeof rank !== 'string') add(`${path}/rank`, 'invalid_type');
          else if (!['normal', 'preferred', 'deprecated'].includes(rank)) add(`${path}/rank`, 'invalid_format');
          const qualifiers: unknown[] = [];
          if (entry.qualifiers !== undefined) {
            if (!Array.isArray(entry.qualifiers)) add(`${path}/qualifiers`, 'invalid_type');
            else {
              if (entry.qualifiers.length > 16) add(`${path}/qualifiers`, 'out_of_range');
              entry.qualifiers.forEach((q, n) => qualifiers.push(validateSnak(q, `${path}/qualifiers/${n}`)));
            }
          }
          const references: { parts: unknown[] }[] = [];
          if (entry.references !== undefined) {
            if (!Array.isArray(entry.references)) add(`${path}/references`, 'invalid_type');
            else {
              if (entry.references.length > 16) add(`${path}/references`, 'out_of_range');
              entry.references.forEach((ref, n) => {
                const refPath = `${path}/references/${n}`;
                if (!isObject(ref)) {
                  add(refPath, 'invalid_type');
                  return;
                }
                fields(ref, ['parts'], refPath);
                if (!Array.isArray(ref.parts) || ref.parts.length < 1 || ref.parts.length > 16)
                  add(`${refPath}/parts`, 'out_of_range');
                const parts: unknown[] = [];
                if (Array.isArray(ref.parts))
                  ref.parts.forEach((part, j) => parts.push(validateSnak(part, `${refPath}/parts/${j}`)));
                references.push({ parts });
              });
            }
          }
          if (snak && typeof rank === 'string')
            entries.push({ property: prop, rank, value: snak.value, qualifiers, references });
        });
        // Selection limits apply to each relation target, including its declared slot key.
        // Unknown values share one property slot unless an external identity is supplied.
        const relation = release?.properties[prop]?.relation;
        const selections = new Map<string, number>();
        for (const entry of entries) {
          const value = entry.value;
          const qualifier = (id: string, absolute = false) =>
            entry.qualifiers.find(
              (part): part is { property: string; value: { type: 'value'; content: string } } =>
                isObject(part) &&
                part.property === id &&
                isObject(part.value) &&
                part.value.type === 'value' &&
                typeof part.value.content === 'string' &&
                (!absolute || /^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/.test(part.value.content)),
            )?.value.content;
          let key = '';
          if (relation && isObject(value)) {
            if (
              value.type === 'value' &&
              typeof value.content === 'string' &&
              /^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.content)
            )
              key = JSON.stringify([
                'target',
                value.content,
                relation.slotKey ? (qualifier(relation.slotKey) ?? '') : '',
              ]);
            else if (value.type === 'somevalue') {
              const iri = qualifier('schema:sameAs', true);
              if (iri) key = JSON.stringify(['external', iri]);
            }
          }
          const count = (selections.get(key) ?? 0) + 1;
          selections.set(key, count);
          if (count === 33) add(at, 'out_of_range');
        }
        drafts.push({ property: prop, entries });
      }
  }
  const count = terms.length + aliasTerms.length + drafts.reduce((sum, group) => sum + group.entries.length, 0);
  if (!errors.length && count > 512) add('', 'out_of_range');
  return { violations: errors, terms, aliasTerms, drafts };
}

const pointerPattern = /^(?:\/(?:[^~/]|~[01])*)*$/;
export type RawIssue = {
  keyword?: unknown;
  instancePath?: unknown;
  params?: unknown;
};

function escapePointerSegment(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

function appendPointer(pointer: string, segment: string): string {
  return `${pointer}/${escapePointerSegment(segment)}`;
}

export function issuePointers(issue: RawIssue): { pointer: string; code: Violation['code'] }[] {
  const keyword = issue.keyword;
  const pointer =
    typeof issue.instancePath === 'string' && pointerPattern.test(issue.instancePath) ? issue.instancePath : '';
  const params =
    typeof issue.params === 'object' && issue.params !== null ? (issue.params as Record<string, unknown>) : {};
  if (keyword === 'required') {
    const names = Array.isArray(params.requiredProperties)
      ? params.requiredProperties
      : [params.missingProperty ?? params.required];
    return names
      .filter((name): name is string => typeof name === 'string')
      .map((name) => ({ pointer: appendPointer(pointer, name), code: 'required' }));
  }
  if (keyword === 'additionalProperties') {
    const names = Array.isArray(params.additionalProperties)
      ? params.additionalProperties
      : [params.additionalProperty ?? params.propertyName];
    return names
      .filter((name): name is string => typeof name === 'string')
      .map((name) => ({ pointer: appendPointer(pointer, name), code: 'unknown_field' }));
  }
  if (typeof keyword !== 'string') return [];
  if (keyword === 'type') return [{ pointer, code: 'invalid_type' }];
  if (
    [
      'minimum',
      'maximum',
      'exclusiveMinimum',
      'exclusiveMaximum',
      'minLength',
      'maxLength',
      'minItems',
      'maxItems',
    ].includes(keyword)
  )
    return [{ pointer, code: 'out_of_range' }];
  if (['pattern', 'format', 'const', 'enum', 'multipleOf'].includes(keyword))
    return [{ pointer, code: 'invalid_format' }];
  return [];
}

export type ItemTarget = { pointer: string; id: string; targets: readonly string[] };

const licenceIds = new Set(spdxLicenseIds);
const authoredDocument = Compile({
  type: 'object',
  required: ['document', 'licence', 'language'],
  additionalProperties: false,
  properties: {
    document: {},
    licence: { type: 'string', minLength: 1, maxLength: 128 },
    language: { type: 'string', minLength: 1, maxLength: 128 },
  },
});

const validators = new WeakMap<object, Map<string, ReturnType<typeof Compile>>>();
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const at = (pointer: string, key: string | number) =>
  `${pointer}/${String(key).replaceAll('~', '~0').replaceAll('/', '~1')}`;

function validator(release: Pick<Release, 'properties'>, id: string, property: PropertyDefinition) {
  let properties = validators.get(release);
  if (!properties) {
    properties = new Map();
    validators.set(release, properties);
  }
  let compiled = properties.get(id);
  if (!compiled) {
    compiled = Compile(property.value);
    properties.set(id, compiled);
  }
  return compiled;
}

// Keep the significant digits and decimal point position separate, including for
// bounds that String(number) writes in scientific notation. Amounts stay strings.
function decimal(value: string) {
  const [coefficient, exponent = '0'] = value.toLowerCase().split('e');
  const unsigned = coefficient!.replace(/^[+-]/, '');
  const point = unsigned.indexOf('.');
  const digits = unsigned.replace('.', '').replace(/^0+/, '');
  const leading = unsigned.replace('.', '').length - digits.length;
  return {
    negative: coefficient!.startsWith('-') && digits.length > 0,
    digits,
    position: (point === -1 ? unsigned.length : point) - leading + Number(exponent),
  };
}

function compareDecimal(left: string, right: string): number {
  const a = decimal(left);
  const b = decimal(right);
  if (a.negative !== b.negative) return a.negative ? -1 : 1;
  let magnitude = 0;
  if (!a.digits.length || !b.digits.length) magnitude = Math.sign(a.digits.length - b.digits.length);
  else if (a.position !== b.position) magnitude = Math.sign(a.position - b.position);
  else {
    const length = Math.max(a.digits.length, b.digits.length);
    const x = a.digits.padEnd(length, '0');
    const y = b.digits.padEnd(length, '0');
    magnitude = x === y ? 0 : x < y ? -1 : 1;
  }
  return a.negative ? -magnitude : magnitude;
}

function dateExists(time: string, precision: number): boolean {
  const match = /^[+-]([0-9]{4,})-([0-9]{2})-([0-9]{2})T00:00:00Z$/.exec(time);
  if (!match) return false;
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (precision === 9) return month === 0 && day === 0;
  if (month < 1 || month > 12) return false;
  if (precision === 10) return day === 0;
  // Divisibility by 400, 100 and 4 depends only on the last four year digits.
  const year = Number(match[1]!.slice(-4));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return precision === 11 && day >= 1 && day <= days[month - 1]!;
}

export function checkSubjectRelease(
  input: unknown,
  release: Pick<Release, 'properties'> & Partial<Pick<Release, 'types'>>,
  rejectContent?: (property: PropertyDefinition) => boolean,
  catalogueOnly = false,
  authoredDocuments = false,
  allowUnknownReferences = false,
): { violations: Violation[]; items: ItemTarget[] } {
  const violations: Violation[] = [];
  const items: ItemTarget[] = [];
  const result = { violations, items };
  const add = (pointer: string, code: Violation['code']) => {
    if (violations.length < 16) violations.push({ pointer, code });
  };
  if (!record(input)) return result;
  if (!catalogueOnly && input.type === undefined) add('/type', 'required');
  else if (!catalogueOnly && typeof input.type !== 'string') add('/type', 'invalid_type');
  else if (!catalogueOnly && (!release.types || !Object.hasOwn(release.types, input.type as string)))
    add('/type', 'unsupported');
  if (violations.length) return result;
  const type = catalogueOnly ? undefined : release.types![input.type as string]!;
  if (!record(input.statements)) return result;

  const checkValue = (raw: Record<string, unknown>, property: PropertyDefinition, id: string, path: string) => {
    if (!record(raw.value) || raw.value.type !== 'value' || !Object.hasOwn(raw.value, 'content')) return;
    const content = raw.value.content;
    const pointer = `${path}/value/content`;
    if (rejectContent?.(property)) {
      add(pointer, 'unsupported');
      return;
    }
    const limits = valueLimits(content, pointer);
    if (limits.length) {
      for (const error of limits) add(error.pointer, error.code);
      return;
    }
    const authored = authoredDocuments && property.datatype === 'document';
    const compiled = authored ? authoredDocument : validator(release, id, property);
    if (!compiled.Check(content)) {
      const [, errors] = compiled.Errors(content);
      for (const error of errors) for (const field of issuePointers(error)) add(pointer + field.pointer, field.code);
      return;
    }
    if (authored && record(content)) {
      if (!record(content.document) || !checkDocument(content.document)) add(`${pointer}/document`, 'invalid_format');
      else if (new TextEncoder().encode(serializeDocument(content.document)).byteLength > 2 * 1024 * 1024)
        add(`${pointer}/document`, 'out_of_range');
      if (
        typeof content.licence === 'string' &&
        !licenceIds.has(content.licence) &&
        !/^LicenseRef-[A-Za-z0-9.-]+$/.test(content.licence)
      )
        add(`${pointer}/licence`, 'invalid_format');
      try {
        if (typeof content.language !== 'string' || /[\u0000-\u001f\u007f-\u009f]/u.test(content.language))
          throw new Error();
        new Intl.Locale(content.language);
      } catch {
        add(`${pointer}/language`, 'invalid_format');
      }
    }
    if (property.datatype === 'quantity' && record(content) && typeof content.amount === 'string') {
      if (
        (property.minimum !== undefined && compareDecimal(content.amount, String(property.minimum)) < 0) ||
        (property.maximum !== undefined && compareDecimal(content.amount, String(property.maximum)) > 0)
      )
        add(`${pointer}/amount`, 'out_of_range');
      for (const bound of ['lowerBound', 'upperBound'] as const) {
        const value = content[bound];
        if (typeof value !== 'string') continue;
        if (
          (bound === 'lowerBound' && compareDecimal(value, content.amount) > 0) ||
          (bound === 'upperBound' && compareDecimal(value, content.amount) < 0) ||
          (property.minimum !== undefined && compareDecimal(value, String(property.minimum)) < 0) ||
          (property.maximum !== undefined && compareDecimal(value, String(property.maximum)) > 0)
        )
          add(`${pointer}/${bound}`, 'out_of_range');
      }
    } else if (
      property.datatype === 'time' &&
      record(content) &&
      typeof content.time === 'string' &&
      typeof content.precision === 'number'
    ) {
      if (!dateExists(content.time, content.precision)) add(`${pointer}/time`, 'invalid_format');
    } else if (property.datatype === 'wikibase-item' && typeof content === 'string') {
      items.push({ pointer, id: content, targets: property.targets! });
    }
  };
  const propertyId = (raw: unknown): string | undefined =>
    record(raw) && record(raw.property) && typeof raw.property.id === 'string' ? raw.property.id : undefined;
  const checkPart = (raw: unknown, path: string, allowed?: readonly string[], allowUnknown = false) => {
    const id = propertyId(raw);
    if (id === undefined) return;
    if (!Object.hasOwn(release.properties, id)) {
      if (allowUnknown) return;
      add(`${path}/property/id`, 'unsupported');
      return;
    }
    if (allowed && !allowed.includes(id)) {
      add(`${path}/property/id`, 'unsupported');
      return;
    }
    checkValue(raw as Record<string, unknown>, release.properties[id]!, id, path);
  };

  for (const [id, list] of Object.entries(input.statements)) {
    const path = at('/statements', id);
    if (catalogueOnly ? !Object.hasOwn(release.properties, id) : !type!.properties.includes(id)) {
      add(path, 'unsupported');
      continue;
    }
    if (!Array.isArray(list)) continue;
    const property = release.properties[id]!;
    list.forEach((statement, index) => {
      if (!record(statement) || propertyId(statement) !== id) return;
      const pointer = at(path, index);
      if (statement.rank === 'deprecated') add(`${pointer}/rank`, 'unsupported');
      if (!property.multivalued && index > 0) add(pointer, 'out_of_range');
      checkValue(statement, property, id, pointer);
      if (Array.isArray(statement.qualifiers))
        statement.qualifiers.forEach((qualifier, j) =>
          checkPart(qualifier, `${pointer}/qualifiers/${j}`, property.qualifiers),
        );
      if (Array.isArray(statement.references))
        statement.references.forEach((reference, k) => {
          if (record(reference) && Array.isArray(reference.parts))
            reference.parts.forEach((part, m) =>
              checkPart(part, `${pointer}/references/${k}/parts/${m}`, undefined, allowUnknownReferences),
            );
        });
    });
  }
  return result;
}

function valueLimits(content: unknown, pointer: string): Violation[] {
  if (!isObject(content)) return [];
  for (const key of ['amount', 'lowerBound', 'upperBound']) {
    if (typeof content[key] === 'string' && content[key].length > 127)
      return [{ pointer: `${pointer}/${key}`, code: 'out_of_range' }];
  }
  if (typeof content.time === 'string' && /^[+-]?[0-9]{17}/.test(content.time))
    return [{ pointer: `${pointer}/time`, code: 'out_of_range' }];
  return [];
}

function combine(first: Violation[], second: Violation[]): Violation[] {
  const seen = new Set<string>();
  // SubjectInputError caps before the HTTP problem formatter keeps the first
  // diagnostic per pointer. Preserve that order for portable callers too.
  return [...first, ...second].slice(0, 16).filter((error) => {
    if (seen.has(error.pointer)) return false;
    seen.add(error.pointer);
    return true;
  });
}

export function checkSubjectInput(
  input: unknown,
  release: Release,
  rejectContent?: (property: PropertyDefinition) => boolean,
  authoredDocuments = false,
): { violations: Violation[]; targets: ItemTarget[] } {
  const structural = checkSubjectStructure(input, release);
  const typed = checkSubjectRelease(input, release, rejectContent, false, authoredDocuments);
  return { violations: combine(structural.violations, typed.violations), targets: typed.items };
}

/** Proposal pointers match the single-statement HTTP envelope. */
export function checkStatementInput(
  raw: unknown,
  release: Pick<Release, 'properties'> | undefined,
  options: {
    rejectContent?: (property: PropertyDefinition) => boolean;
    authoredDocuments?: boolean;
    /** Exact Type descriptors need not include every otherwise valid reference property. Native writes validate those. */
    allowUnknownReferences?: boolean;
  } = {},
): { violations: Violation[]; targets: ItemTarget[] } {
  const property =
    isObject(raw) && isObject(raw.property) && typeof raw.property.id === 'string' ? raw.property.id : '';
  const escaped = property.replaceAll('~', '~0').replaceAll('/', '~1');
  const prefix = `/statements/${escaped}/0`;
  const remap = (error: Violation): Violation => ({
    ...error,
    pointer:
      error.pointer === `/statements/${escaped}`
        ? '/statement/property/id'
        : error.pointer.replace(prefix, '/statement'),
  });
  // A proposal's subject type must be checked by the caller against its database.
  const input = { type: '', labels: { en: 'Validation' }, statements: { [property]: [raw] } };
  const typed = release
    ? checkSubjectRelease(
        input,
        release,
        options.rejectContent,
        true,
        options.authoredDocuments,
        options.allowUnknownReferences,
      )
    : { violations: [], items: [] };
  const violations = typed.violations.map(remap);
  if (
    release?.properties[property]?.disclosure !== 'sourceOrConsent' &&
    (!isObject(raw) || !Array.isArray(raw.references) || !raw.references.length)
  )
    violations.push({ pointer: '/statement/references', code: 'required' });
  const structural = checkSubjectStructure(input).violations.map(remap);
  return {
    violations: combine(violations, structural),
    targets: typed.items.map((item) => ({ ...item, pointer: item.pointer.replace(prefix, '/statement') })),
  };
}
