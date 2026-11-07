import type { DataType, RelationDefinition, Release } from '@rezics/definitions/contract';
import { checkSubjectStructure, type Violation } from '@rezics/definitions/validate';
import {
  ITEM_FACT_LIMIT,
  ITEM_RELATION_GROUPS,
  ITEM_SLOT_NAMESPACE,
  ITEM_STATEMENT_NAMESPACE,
  type Item,
  type ItemDataType,
  type ItemFact,
  type ItemFactRow,
  type ItemMetadata,
  type ItemStatement,
  type ItemValue,
} from '../contract/item-values.ts';
import type { HashPort, RoutePort } from '../contract/domain-ports.ts';

export { ITEM_FACT_LIMIT, ITEM_RELATION_GROUPS, ITEM_SLOT_NAMESPACE, ITEM_STATEMENT_NAMESPACE };
export const RELATION_GROUPS = new Set<string>(ITEM_RELATION_GROUPS);
const OCCUPATION_PROPERTY = 'wdt:P106';

export class SubjectInputError extends Error {
  readonly violations: Violation[];
  constructor(violations: Violation[]) {
    super('Subject input is invalid');
    this.name = 'SubjectInputError';
    this.violations = violations.slice(0, 16);
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export function factDataTypes(release: Release, facts: readonly ItemFactRow[]): Record<string, DataType> {
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

function hasRelationSlots(property: string, relation: RelationDefinition | undefined): relation is RelationDefinition {
  return (
    RELATION_GROUPS.has(relation?.group ?? '') ||
    (property === OCCUPATION_PROPERTY && relation?.group === 'classification')
  );
}

export function statementSlotId(route: RoutePort, subject: string, property: string): string {
  const subjectRoute = route.routeOf(subject);
  if (subjectRoute === null) throw new RangeError('Subject id must be a canonical routed id');
  return route.derivedId(ITEM_SLOT_NAMESPACE, `${subject}\nstatement\n${property}`, subjectRoute);
}

export function relationSlotId(
  route: RoutePort,
  subject: string,
  property: string,
  target: string,
  slotKey?: { declared: boolean; value: string },
): string {
  const subjectRoute = route.routeOf(subject);
  if (subjectRoute === null) throw new RangeError('Subject id must be a canonical routed id');
  const relation = `${subject}\nrelation\n${property}\n${target}${slotKey?.declared ? `\n${slotKey.value}` : ''}`;
  return route.derivedId(ITEM_SLOT_NAMESPACE, relation, subjectRoute);
}

function absoluteIri(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/.test(value);
}

export function relationSlotForStatement(
  route: RoutePort,
  subject: string,
  property: string,
  body: unknown,
  relation?: RelationDefinition,
): string {
  const fallback = statementSlotId(route, subject, property);
  if (!hasRelationSlots(property, relation) || !isObject(body) || !isObject(body.value)) return fallback;
  const value = body.value as { type?: unknown; content?: unknown };
  if (value.type === 'value' && typeof value.content === 'string' && route.routeOf(value.content) !== null) {
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
    return relationSlotId(route, subject, property, value.content, {
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
    const subjectRoute = route.routeOf(subject);
    if (sameAs && subjectRoute !== null)
      return route.derivedId(
        ITEM_SLOT_NAMESPACE,
        `${subject}\nrelation\n${property}\nexternal\n${sameAs.value.content}`,
        subjectRoute,
      );
  }
  return fallback;
}

export function relationSlotForApi(
  route: RoutePort,
  subject: string,
  property: string,
  relation: RelationDefinition | undefined,
  input: { target?: string; sameAs?: string; key?: string },
): string {
  if (!hasRelationSlots(property, relation)) return statementSlotId(route, subject, property);
  if (input.target !== undefined) {
    return relationSlotId(route, subject, property, input.target, {
      declared: relation.slotKey !== undefined,
      value: input.key ?? '',
    });
  }
  const subjectRoute = route.routeOf(subject);
  if (input.sameAs !== undefined && subjectRoute !== null)
    return route.derivedId(
      ITEM_SLOT_NAMESPACE,
      `${subject}\nrelation\n${property}\nexternal\n${input.sameAs}`,
      subjectRoute,
    );
  return statementSlotId(route, subject, property);
}

export function canonicalItemValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalItemValue).join(',')}]`;
  if (isObject(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalItemValue(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

export function itemFacts(
  route: RoutePort,
  subjectId: string,
  input: unknown,
  _type?: string,
  release?: Release,
): ItemFact[] {
  const subjectRoute = route.routeOf(subjectId);
  if (subjectRoute === null) throw new RangeError('Subject id must be a canonical routed id');
  const { violations, terms, aliasTerms, drafts } = checkSubjectStructure(input, release);
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
  const facts: ItemFact[] = [];
  const put = (
    kind: ItemFact['kind'],
    key: string,
    seq: number,
    body: unknown,
    language: string | null,
    property: string | null,
    statementId: string | null,
    explicitSlotId?: string,
  ) =>
    facts.push({
      slot_id: explicitSlotId ?? route.derivedId(ITEM_SLOT_NAMESPACE, `${subjectId}\n${kind}\n${key}`, subjectRoute),
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
        route,
        subjectId,
        group.property,
        body,
        release?.properties[group.property]?.relation,
      );
      const seq = (sequences.get(slot) ?? 0) + 1;
      sequences.set(slot, seq);
      const statementId = route.derivedId(ITEM_STATEMENT_NAMESPACE, `${slot}\n${seq}`, subjectRoute);
      put('statement', group.property, seq, body, null, group.property, statementId, slot);
    });
  }
  return facts;
}

export function resolveItem(
  hash: HashPort,
  subjectId: string,
  rows: readonly ItemFactRow[],
  type: string,
  dataTypes: Readonly<Record<string, DataType | ItemDataType>>,
  metadata: ItemMetadata,
): Item {
  const labels: Record<string, string> = {};
  const descriptions: Record<string, string> = {};
  const aliases = new Map<string, string[]>();
  const statements = new Map<string, ItemStatement[]>();
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
          rank: ItemStatement['rank'];
          value: ItemValue;
          qualifiers: { property: string; value: ItemValue }[];
          references: { parts: { property: string; value: ItemValue }[] }[];
        };
        const snak = (entry: { property: string; value: ItemValue }) => ({
          property: { id: entry.property, data_type: dataTypes[entry.property]! as ItemDataType },
          value: entry.value,
        });
        const refs = body.references.map((ref) => ({
          parts: ref.parts.map(snak),
          hash: hash.sha256Hex(canonicalItemValue(ref.parts)),
        }));
        const resolved: ItemStatement = {
          id: row.statement_id!,
          rank: body.rank,
          property: { id: property, data_type: dataTypes[property]! as ItemDataType },
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

export function relationPropertiesOf(release: Release, type: string): string[] {
  return (release.types[type]?.properties ?? []).filter((property) => isRelationProperty(release, property));
}

export function storedFactsFor(
  facts: readonly ItemFact[],
  releaseDigest: string,
  release: Release,
): Array<ItemFact & { release: string | null; relation?: boolean }> {
  return facts.map((fact) => ({
    ...fact,
    release: fact.kind === 'statement' ? releaseDigest : null,
    relation: fact.kind === 'statement' && isRelationProperty(release, fact.property!),
  }));
}
