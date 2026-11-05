import { createHash } from 'node:crypto';
import type { DataType, RelationDefinition, Release } from '@rezics/definitions';
import { checkSubjectStructure, type Violation } from '@rezics/definitions/validate';
export type { Violation } from '@rezics/definitions/validate';
import { derivedId, routeOf } from '../route/route.ts';
import type { SourceRecord } from './source-records.ts';

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
  rezics: { release: string; revision: number };
};
export type Item = {
  id: string;
  type: string;
  revision: number;
  release: string;
  context: string;
  resolution: Record<string, 'unresolved' | 'suppressed'>;
  relationCounts: Record<string, number>;
  labels: Record<string, string>;
  descriptions: Record<string, string>;
  aliases: Record<string, string[]>;
  statements: Record<string, Statement[]>;
  sourceRecords: SourceRecord[];
};
export type Fact = {
  slot_id: string;
  log_seq: number;
  operation: 'assert' | 'retract' | 'expand';
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
  fact_revision?: number | null;
  fact_release?: string | null;
};
/** Datatypes for the properties named by these facts, without walking the rest of the release. */
export function factDataTypes(release: Release, facts: readonly FactRow[]): Record<string, DataType> {
  const dataTypes: Record<string, DataType> = {};
  const add = (id: unknown) => {
    if (typeof id !== 'string' || Object.hasOwn(dataTypes, id)) return;
    const datatype = release.properties[id]?.datatype;
    if (datatype !== undefined) dataTypes[id] = datatype;
  };
  for (const fact of facts) {
    add(fact.property);
    if (fact.kind !== 'statement' || !isObject(fact.body)) continue;
    const body = fact.body;
    if (Array.isArray(body.qualifiers))
      for (const qualifier of body.qualifiers) if (isObject(qualifier)) add(qualifier.property);
    if (Array.isArray(body.references)) {
      for (const reference of body.references) {
        if (!isObject(reference) || !Array.isArray(reference.parts)) continue;
        for (const part of reference.parts) if (isObject(part)) add(part.property);
      }
    }
  }
  return dataTypes;
}

export class SubjectInputError extends Error {
  readonly violations: Violation[];
  constructor(violations: Violation[]) {
    super('Subject input is invalid');
    this.name = 'SubjectInputError';
    this.violations = violations.slice(0, 16);
  }
}

export const SLOT_NS = 'c30d6caa-d9e8-4108-a42a-35701219e8ec';
const STATEMENT_NS = '9f44e74c-b77c-47aa-96d0-b7a4aa330182';
export const RELATION_GROUPS = new Set([
  'order',
  'derivation',
  'world',
  'membership',
  'association',
  'credit',
  'appearance',
]);
const OCCUPATION_PROPERTY = 'wdt:P106';
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export function isRelationProperty(release: Release, property: string): boolean {
  const definition = release.properties[property];
  if (RELATION_GROUPS.has(definition?.relation?.group ?? '')) return true;
  return (
    property === OCCUPATION_PROPERTY &&
    release.types['schema:Person']?.properties.includes(property) === true &&
    definition?.datatype === 'wikibase-item' &&
    definition.relation?.group === 'classification' &&
    definition.targets?.length === 1 &&
    definition.targets[0] === 'skos:Concept'
  );
}

function hasRelationSlots(
  property: string,
  relation: RelationDefinition | undefined,
): relation is RelationDefinition {
  return (
    RELATION_GROUPS.has(relation?.group ?? '') ||
    (property === OCCUPATION_PROPERTY && relation?.group === 'classification')
  );
}

export function statementSlotId(subject: string, property: string): string {
  return derivedId(SLOT_NS, `${subject}\nstatement\n${property}`, routeOf(subject)!);
}

/** Relation slots isolate one target (and, where declared, one repeatable item qualifier). */
export function relationSlotId(
  subject: string,
  property: string,
  target: string,
  slotKey?: { declared: boolean; value: string },
): string {
  const relation = `${subject}\nrelation\n${property}\n${target}${slotKey?.declared ? `\n${slotKey.value}` : ''}`;
  return derivedId(SLOT_NS, relation, routeOf(subject)!);
}

function absoluteIri(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/.test(value);
}

export function relationSlotForStatement(
  subject: string,
  property: string,
  body: unknown,
  relation?: RelationDefinition,
): string {
  const fallback = statementSlotId(subject, property);
  if (!hasRelationSlots(property, relation) || !isObject(body) || !isObject(body.value)) return fallback;
  const value = body.value as { type?: unknown; content?: unknown };
  if (value.type === 'value' && typeof value.content === 'string' && routeOf(value.content) !== null) {
    const key = relation.slotKey
      ? Array.isArray(body.qualifiers)
        ? (body.qualifiers.find(
            (qualifier) =>
              isObject(qualifier) &&
              qualifier.property === relation.slotKey &&
              isObject(qualifier.value) &&
              qualifier.value.type === 'value' &&
              typeof qualifier.value.content === 'string',
          )?.value as { content: string } | undefined)
        : undefined
      : undefined;
    return relationSlotId(subject, property, value.content, {
      declared: relation.slotKey !== undefined,
      value: key?.content ?? '',
    });
  }
  if (value.type === 'somevalue' && Array.isArray(body.qualifiers)) {
    const sameAs = body.qualifiers.find(
      (qualifier) =>
        isObject(qualifier) &&
        qualifier.property === 'schema:sameAs' &&
        isObject(qualifier.value) &&
        qualifier.value.type === 'value' &&
        absoluteIri(qualifier.value.content),
    ) as { value: { content: string } } | undefined;
    if (sameAs)
      return derivedId(
        SLOT_NS,
        `${subject}\nrelation\n${property}\nexternal\n${sameAs.value.content}`,
        routeOf(subject)!,
      );
  }
  return fallback;
}

export function relationSlotForApi(
  subject: string,
  property: string,
  relation: RelationDefinition | undefined,
  input: { target?: string; sameAs?: string; key?: string },
): string {
  if (!hasRelationSlots(property, relation)) return statementSlotId(subject, property);
  if (input.target !== undefined) {
    return relationSlotId(subject, property, input.target, {
      declared: relation.slotKey !== undefined,
      value: input.key ?? '',
    });
  }
  if (input.sameAs !== undefined)
    return derivedId(SLOT_NS, `${subject}\nrelation\n${property}\nexternal\n${input.sameAs}`, routeOf(subject)!);
  return statementSlotId(subject, property);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

export function itemFacts(subjectId: string, input: unknown, _type?: string, release?: Release): Fact[] {
  const route = routeOf(subjectId);
  if (route === null) throw new RangeError('Subject id must be a canonical routed id');
  const { violations, terms, aliasTerms, drafts } = checkSubjectStructure(input, release);
  // Typed statement fragments describe an existing subject; creation validates its full item separately.
  const statementFragment =
    _type !== undefined &&
    release !== undefined &&
    isObject(input) &&
    Object.keys(input).every((key) => key === 'statements') &&
    isObject(input.statements);
  const errors = statementFragment
    ? violations.filter((violation) => violation.pointer !== '/labels' || violation.code !== 'required')
    : violations;
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
    explicitSlotId?: string,
  ) =>
    facts.push({
      slot_id: explicitSlotId ?? derivedId(SLOT_NS, `${subjectId}\n${kind}\n${key}`, route),
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
  for (const group of drafts) {
    const sequences = new Map<string, number>();
    group.entries.forEach((entry) => {
      const bare = (snak: unknown) => {
        const s = snak as { property: string; value: unknown };
        return { property: s.property, value: s.value };
      };
      const references = entry.references.map((ref) => ({ parts: ref.parts.map(bare) }));
      const body = {
        rank: entry.rank,
        value: entry.value,
        qualifiers: entry.qualifiers.map(bare),
        references,
      };
      const slot = relationSlotForStatement(
        subjectId,
        group.property,
        body,
        release?.properties[group.property]?.relation,
      );
      const seq = (sequences.get(slot) ?? 0) + 1;
      sequences.set(slot, seq);
      const statementId = derivedId(STATEMENT_NS, `${slot}\n${seq}`, route);
      put('statement', group.property, seq, body, null, group.property, statementId, slot);
    });
  }
  return facts;
}

export function resolveItem(
  subjectId: string,
  rows: readonly FactRow[],
  type: string,
  dataTypes: Readonly<Record<string, DataType>>,
  metadata: {
    revision: number;
    release: string;
    context: string;
    resolution?: Record<string, 'unresolved' | 'suppressed'>;
    relationCounts?: Record<string, number>;
  },
): Item {
  const labels: Record<string, string> = {};
  const descriptions: Record<string, string> = {};
  const aliases = new Map<string, string[]>();
  const statements = new Map<string, Statement[]>();
  for (const row of rows) {
    if (row.operation === 'expand') continue;
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
          property: { id: entry.property, data_type: dataTypes[entry.property]! },
          value: entry.value,
        });
        const refs = body.references.map((ref) => ({
          parts: ref.parts.map(snak),
          hash: createHash('sha256').update(canonical(ref.parts)).digest('hex'),
        }));
        const resolved: Statement = {
          id: row.statement_id!,
          rank: body.rank,
          property: { id: property, data_type: dataTypes[property]! },
          value: body.value,
          qualifiers: body.qualifiers.map(snak),
          references: refs,
          rezics: {
            revision: row.fact_revision ?? metadata.revision,
            release: row.fact_release ?? metadata.release,
          },
        };
        if (index >= 0) list.splice(index, 1);
        list.push(resolved);
      }
      statements.set(property, list);
    }
  }
  return {
    id: subjectId,
    type,
    ...metadata,
    resolution: metadata.resolution ?? {},
    relationCounts: metadata.relationCounts ?? {},
    labels,
    descriptions,
    aliases: Object.fromEntries([...aliases].filter(([, values]) => values.length)),
    statements: Object.fromEntries([...statements].filter(([, values]) => values.length)),
    sourceRecords: [],
  };
}
