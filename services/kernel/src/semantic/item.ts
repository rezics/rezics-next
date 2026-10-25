import { createHash } from 'node:crypto';
import { derivedId, routeOf } from '../route/route.ts';
import { propertyOf, SUBJECT_TYPE, type DataType } from './profile.ts';

export type Value = { type: 'value'; content: unknown } | { type: 'somevalue' } | { type: 'novalue' };
export type Snak = { property: { id: string; data_type: DataType }; value: Value };
export type Reference = { parts: Snak[]; hash: string };
export type Statement = {
  id: string;
  rank: 'normal' | 'preferred' | 'deprecated';
  property: { id: string; data_type: DataType };
  value: Value;
  qualifiers: Snak[];
  references: Reference[];
};
export type Item = {
  id: string;
  type: typeof SUBJECT_TYPE;
  labels: Record<string, string>;
  descriptions: Record<string, string>;
  aliases: Record<string, string[]>;
  statements: Record<string, Statement[]>;
};
export type Fact = {
  slot_id: string;
  log_seq: number;
  operation: 'assert' | 'retract';
  kind: 'label' | 'description' | 'alias' | 'statement';
  language: string | null;
  property: string | null;
  statement_id: string | null;
  body: unknown;
};
export type FactRow = {
  kind: Fact['kind'];
  language: string | null;
  property: string | null;
  statement_id: string | null;
  operation: Fact['operation'];
  body: unknown;
};
export type Violation = {
  pointer: string;
  code: 'required' | 'unknown_field' | 'invalid_type' | 'invalid_format' | 'out_of_range' | 'unsupported';
};

export class SubjectInputError extends Error {
  readonly violations: Violation[];
  constructor(violations: Violation[]) {
    super('Subject input is invalid');
    this.name = 'SubjectInputError';
    this.violations = violations.slice(0, 16);
  }
}

const SLOT_NS = 'c30d6caa-d9e8-4108-a42a-35701219e8ec';
const STATEMENT_NS = '9f44e74c-b77c-47aa-96d0-b7a4aa330182';
const languagePattern = /^[a-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/;
const amountPattern = /^[+-](?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const pointer = (base: string, part: string | number) =>
  `${base}/${String(part).replaceAll('~', '~0').replaceAll('/', '~1')}`;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

export function itemFacts(subjectId: string, input: unknown): Fact[] {
  const route = routeOf(subjectId);
  if (route === null) throw new RangeError('Subject id must be a canonical routed id');
  const errors: Violation[] = [];
  const add = (at: string, code: Violation['code']) => {
    if (errors.length < 16) errors.push({ pointer: at, code });
  };
  const fields = (obj: Record<string, unknown>, allowed: string[], base: string) => {
    for (const key of Object.keys(obj)) if (!allowed.includes(key)) add(pointer(base, key), 'unknown_field');
  };
  if (!isObject(input)) {
    throw new SubjectInputError([{ pointer: '', code: 'invalid_type' }]);
  }
  fields(input, ['labels', 'descriptions', 'aliases', 'statements'], '');
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
    if (!propertyOf(id)) add(`${at}/property/id`, 'unsupported');
    if (expected && id !== expected) add(`${at}/property/id`, 'invalid_format');
    const val = raw.value;
    if (!isObject(val) || !['value', 'somevalue', 'novalue'].includes(String(val.type))) {
      add(`${at}/value`, 'invalid_format');
      return null;
    }
    fields(val, val.type === 'value' ? ['type', 'content'] : ['type'], `${at}/value`);
    if (val.type === 'value') {
      if (!own(val, 'content')) add(`${at}/value/content`, 'required');
      else validateContent(id, val.content, `${at}/value/content`, add);
    } else if (own(val, 'content')) add(`${at}/value/content`, 'unknown_field');
    return { property: id, value: val };
  };
  if (input.statements !== undefined) {
    if (!isObject(input.statements)) add('/statements', 'invalid_type');
    else
      for (const [prop, list] of Object.entries(input.statements)) {
        const at = `/statements/${prop.replaceAll('~', '~0').replaceAll('/', '~1')}`;
        if (!propertyOf(prop)) {
          add(at, 'unsupported');
          continue;
        }
        if (!Array.isArray(list)) {
          add(at, 'invalid_type');
          continue;
        }
        if (list.length > 32) add(at, 'out_of_range');
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
          const rank = entry.rank ?? 'normal';
          if (!['normal', 'preferred', 'deprecated'].includes(String(rank))) add(`${path}/rank`, 'invalid_format');
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
          if (snak) entries.push({ property: prop, rank: String(rank), value: snak.value, qualifiers, references });
        });
        drafts.push({ property: prop, entries });
      }
  }
  if (errors.length) throw new SubjectInputError(errors);
  const facts: Fact[] = [];
  const put = (
    kind: Fact['kind'],
    key: string,
    seq: number,
    body: unknown,
    language: string | null,
    property: string | null,
    statementId: string | null,
  ) =>
    facts.push({
      slot_id: derivedId(SLOT_NS, `${subjectId}\n${kind}\n${key}`, route),
      log_seq: seq,
      operation: 'assert',
      kind,
      language,
      property,
      statement_id: statementId,
      body,
    });
  for (const t of terms) put(t.kind, t.language, 1, t.body, t.language, null, null);
  const aliasSeq = new Map<string, number>();
  for (const t of aliasTerms) {
    const seq = (aliasSeq.get(t.language) ?? 0) + 1;
    aliasSeq.set(t.language, seq);
    put('alias', t.language, seq, t.body, t.language, null, null);
  }
  for (const group of drafts)
    group.entries.forEach((entry, i) => {
      const seq = i + 1;
      const slotId = derivedId(SLOT_NS, `${subjectId}\nstatement\n${group.property}`, route);
      const statementId = derivedId(STATEMENT_NS, `${slotId}\n${seq}`, route);
      const bare = (snak: unknown) => {
        const s = snak as { property: string; value: unknown };
        return { property: s.property, value: s.value };
      };
      const references = entry.references.map((ref) => ({ parts: ref.parts.map(bare) }));
      put(
        'statement',
        group.property,
        seq,
        { rank: entry.rank, value: entry.value, qualifiers: entry.qualifiers.map(bare), references },
        null,
        group.property,
        statementId,
      );
    });
  if (facts.length > 512) throw new SubjectInputError([{ pointer: '', code: 'out_of_range' }]);
  return facts;
}

function validateContent(
  id: string,
  content: unknown,
  at: string,
  add: (pointer: string, code: Violation['code']) => void,
): void {
  const type = propertyOf(id)?.dataType;
  if (!type) return;
  if (type === 'document' || type === 'media') {
    add(at, 'unsupported');
  } else if (type === 'wikibase-item') {
    if (typeof content !== 'string') add(at, 'invalid_type');
    else if (routeOf(content) === null) add(at, 'invalid_format');
  } else if (type === 'external-id') {
    if (typeof content !== 'string') add(at, 'invalid_type');
    else if (content.length < 1 || content.length > 1500)
      add(at, content.length > 1500 ? 'out_of_range' : 'invalid_format');
  } else if (type === 'quantity') {
    if (!isObject(content)) {
      add(at, 'invalid_type');
      return;
    }
    if (Object.keys(content).some((key) => !['amount', 'unit'].includes(key))) add(at, 'unknown_field');
    if (typeof content.amount !== 'string' || content.unit !== '1' || !amountPattern.test(content.amount))
      add(at, 'invalid_format');
  } else {
    if (typeof content !== 'string') {
      add(at, 'invalid_type');
      return;
    }
    try {
      const url = new URL(content);
      if (content.length > 1500) add(at, 'out_of_range');
      else if (!['http:', 'https:'].includes(url.protocol)) add(at, 'invalid_format');
    } catch {
      add(at, content.length > 1500 ? 'out_of_range' : 'invalid_format');
    }
  }
}

export function resolveItem(subjectId: string, rows: readonly FactRow[]): Item {
  const labels: Record<string, string> = {};
  const descriptions: Record<string, string> = {};
  const aliases = new Map<string, string[]>();
  const statements = new Map<string, Statement[]>();
  for (const row of rows) {
    if (row.kind === 'label' || row.kind === 'description') {
      const target = row.kind === 'label' ? labels : descriptions;
      if (row.operation === 'retract') delete target[row.language!];
      else target[row.language!] = row.body as string;
    } else if (row.kind === 'alias') {
      const list = aliases.get(row.language!) ?? [];
      const index = list.indexOf(row.body as string);
      if (row.operation === 'retract') {
        if (index >= 0) list.splice(index, 1);
      } else if (index < 0) list.push(row.body as string);
      aliases.set(row.language!, list);
    } else {
      const property = row.property!;
      const list = statements.get(property) ?? [];
      const index = list.findIndex((statement) => statement.id === row.statement_id);
      if (row.operation === 'retract') {
        if (index >= 0) list.splice(index, 1);
      } else {
        const body = row.body as {
          rank: Statement['rank'];
          value: Value;
          qualifiers: { property: string; value: Value }[];
          references: { parts: { property: string; value: Value }[] }[];
        };
        const snak = (entry: { property: string; value: Value }): Snak => ({
          property: { id: entry.property, data_type: propertyOf(entry.property)!.dataType },
          value: entry.value,
        });
        const refs = body.references.map((ref) => ({
          parts: ref.parts.map(snak),
          hash: createHash('sha256').update(canonical(ref.parts)).digest('hex'),
        }));
        const resolved: Statement = {
          id: row.statement_id!,
          rank: body.rank,
          property: { id: property, data_type: propertyOf(property)!.dataType },
          value: body.value,
          qualifiers: body.qualifiers.map(snak),
          references: refs,
        };
        if (index >= 0) list.splice(index, 1);
        list.push(resolved);
      }
      statements.set(property, list);
    }
  }
  return {
    id: subjectId,
    type: SUBJECT_TYPE,
    labels,
    descriptions,
    aliases: Object.fromEntries([...aliases].filter(([, values]) => values.length)),
    statements: Object.fromEntries([...statements].filter(([, values]) => values.length)),
  };
}
