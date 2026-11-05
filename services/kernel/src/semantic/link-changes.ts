import type { Release } from '@rezics/definitions';
import { holderKeys, positionKey } from './link-keys.ts';
import type { FactRow } from './item.ts';
import { relationSlotForStatement, statementSlotId } from './item.ts';
import { routeOf } from '../route/route.ts';

export type LinkChange = {
  context_id?: string;
  suppressed?: boolean;
  property: string;
  statement: string;
  target: string | null;
  present: boolean;
  project_outbound?: boolean;
  relation?: boolean;
  slot_id?: string;
  external?: string | null;
  value?: 'somevalue' | 'novalue' | 'value';
  outbound_order?: 'position' | 'date' | 'name' | null;
  outbound_order_key?: string;
  source_type?: string;
  order_key?: string;
  filter_value?: string;
};

type LinkFact = {
  kind: string;
  operation: string;
  property: string | null;
  statement_id: string | null;
  body: unknown;
};

const linkKey = (link: { property: string; statement: string; target: string | null }) => {
  const row = link as LinkChange;
  return `${link.property}\0${link.statement}\0${link.target ?? ''}\0${row.external ?? ''}\0${row.filter_value ?? ''}`;
};

function linkTarget(
  fact: LinkFact,
  dataTypes: Readonly<Record<string, string>>,
): {
  property: string;
  statement: string;
  target: string | null;
  external?: string | null;
  value?: 'value' | 'somevalue' | 'novalue';
} | null {
  if (fact.kind !== 'statement' || fact.operation !== 'assert' || fact.property === null || fact.statement_id === null)
    return null;
  if (dataTypes[fact.property] !== 'wikibase-item') return null;
  if (fact.body === null || typeof fact.body !== 'object' || Array.isArray(fact.body)) return null;
  const body = fact.body as {
    rank?: unknown;
    value?: unknown;
    qualifiers?: { property: string; value: { type: string; content?: unknown } }[];
  };
  if (body.rank !== 'normal' && body.rank !== 'preferred') return null;
  if (body.value === null || typeof body.value !== 'object' || Array.isArray(body.value)) return null;
  const value = body.value as { type?: unknown; content?: unknown };
  if (value.type === 'value' && typeof value.content === 'string' && routeOf(value.content) !== null)
    return { property: fact.property, statement: fact.statement_id, target: value.content, value: 'value' };
  if (value.type === 'somevalue' || value.type === 'novalue') {
    const external =
      value.type === 'somevalue'
        ? (body.qualifiers ?? []).find(
            (qualifier) =>
              qualifier.property === 'schema:sameAs' &&
              qualifier.value.type === 'value' &&
              typeof qualifier.value.content === 'string' &&
              /^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/.test(qualifier.value.content),
          )?.value.content
        : undefined;
    return {
      property: fact.property,
      statement: fact.statement_id,
      target: null,
      external: typeof external === 'string' ? external : null,
      value: value.type,
    };
  }
  return null;
}

function linksOf(
  facts: readonly LinkFact[],
  dataTypes: Readonly<Record<string, string>>,
  metadata?: { subject: string; release: Release; type: string; identityFacts?: readonly FactRow[] },
): Map<string, Omit<LinkChange, 'present'>> {
  const links = new Map<string, Omit<LinkChange, 'present'>>();
  const holder = metadata
    ? holderKeys([...(metadata.identityFacts ?? []), ...(facts as FactRow[])], metadata.type)
    : null;
  for (const fact of facts) {
    const link = linkTarget(fact, dataTypes);
    if (!link) continue;
    const relation = metadata?.release.properties[link.property]?.relation;
    const relationStatement = !!relation && relation.group !== 'classification';
    if (link.target === null && !relationStatement) continue;
    if (!metadata || !holder) {
      links.set(linkKey(link), link);
      continue;
    }
    const body = fact.body as { qualifiers?: { property: string; value: { type: string; content?: unknown } }[] };
    const qualifiers = body.qualifiers ?? [];
    const positions = qualifiers
      .filter((q) => q.property === 'schema:position' && q.value.type === 'value')
      .map((q) => positionKey(q.value.content))
      .sort();
    const order = relation?.order;
    const order_key =
      order === 'name'
        ? holder.name
        : order === 'date'
          ? holder.date
          : order === 'position'
            ? (positions[0] ?? '1')
            : '';
    const outbound_order_key = order === 'position' ? (positions[0] ?? '1') : '';
    const slot_id =
      relationStatement && metadata.subject
        ? relationSlotForStatement(metadata.subject, link.property, fact.body, relation)
        : statementSlotId(metadata.subject, link.property);
    const values = new Set(['00000000-0000-0000-0000-000000000000']);
    const filters = Array.isArray(relation?.filter) ? relation.filter : relation?.filter ? [relation.filter] : [];
    for (const qualifier of qualifiers) {
      if (
        filters.includes(qualifier.property) &&
        qualifier.value.type === 'value' &&
        typeof qualifier.value.content === 'string' &&
        routeOf(qualifier.value.content) !== null
      )
        values.add(qualifier.value.content);
    }
    for (const filter_value of values) {
      const keyed = {
        ...link,
        project_outbound: true,
        relation: relationStatement,
        slot_id,
        external: link.external ?? null,
        ...(link.value === undefined ? {} : { value: link.value }),
        outbound_order: relationStatement ? (order ?? null) : null,
        outbound_order_key: relationStatement ? outbound_order_key : '',
        source_type: holder.source_type,
        order_key,
        filter_value,
      };
      links.set(linkKey(keyed), keyed);
    }
    if (link.property === 'wdt:P725' && relation?.slotKey === 'wdt:P453' && link.value === 'value' && link.target) {
      const character = qualifiers.find(
        (qualifier) =>
          qualifier.property === 'wdt:P453' &&
          qualifier.value.type === 'value' &&
          typeof qualifier.value.content === 'string' &&
          routeOf(qualifier.value.content) !== null,
      )?.value.content;
      if (typeof character === 'string') {
        const keyed = {
          ...link,
          target: character,
          project_outbound: false,
          relation: relationStatement,
          slot_id,
          external: null,
          value: 'value' as const,
          outbound_order: relationStatement ? (order ?? null) : null,
          outbound_order_key: relationStatement ? outbound_order_key : '',
          source_type: holder.source_type,
          order_key,
          filter_value: character,
        };
        links.set(linkKey(keyed), keyed);
      }
    }
  }
  return links;
}

/** Preferred and normal item statements shown by the Global view. Ranks are not part of a link. */
export function linkChanges(
  before: readonly LinkFact[],
  after: readonly LinkFact[],
  dataTypes: Readonly<Record<string, string>>,
  metadata?: {
    subject: string;
    release: Release;
    type: string;
    identityFacts?: readonly FactRow[];
    beforeType?: string;
    refresh?: boolean;
  },
): LinkChange[] {
  const previous = linksOf(
    before,
    dataTypes,
    metadata ? { ...metadata, type: metadata.beforeType ?? metadata.type } : undefined,
  );
  const next = linksOf(after, dataTypes, metadata);
  const holderChanged =
    metadata &&
    JSON.stringify(holderKeys(before as FactRow[], metadata.beforeType ?? metadata.type)) !==
      JSON.stringify(holderKeys(after as FactRow[], metadata.type));
  const changes: LinkChange[] = [];
  for (const [key, link] of previous) {
    if (!next.has(key)) changes.push({ ...link, present: false });
  }
  for (const [key, link] of next) {
    if (
      metadata?.refresh ||
      holderChanged ||
      !previous.has(key) ||
      JSON.stringify(previous.get(key)) !== JSON.stringify(link)
    )
      changes.push({ ...link, present: true });
  }
  changes.sort((left, right) => {
    if (left.property !== right.property) return left.property < right.property ? -1 : 1;
    if (left.statement !== right.statement) return left.statement < right.statement ? -1 : 1;
    if (left.target !== right.target) {
      if (left.target === null) return 1;
      if (right.target === null) return -1;
      return left.target < right.target ? -1 : 1;
    }
    return 0;
  });
  return changes;
}

/** Changes to a Context's sparse layer, relative to the same Global slot snapshot. */
export function contextLinkChanges(
  global: readonly LinkFact[],
  before: readonly LinkFact[],
  after: readonly LinkFact[],
  dataTypes: Readonly<Record<string, string>>,
  metadata: { subject: string; release: Release; type: string; identityFacts?: readonly FactRow[] },
  context: string,
  nextGlobal: readonly LinkFact[] = global,
): LinkChange[] {
  const layer = (globalFacts: readonly LinkFact[], facts: readonly LinkFact[]) => {
    const base = linksOf(globalFacts, dataTypes, metadata);
    const selected = linksOf(facts, dataTypes, metadata);
    const result = new Map<string, LinkChange>();
    for (const [key, link] of base)
      if (!selected.has(key)) result.set(key, { ...link, context_id: context, present: true, suppressed: true });
    for (const [key, link] of selected)
      if (!base.has(key)) result.set(key, { ...link, context_id: context, present: true, suppressed: false });
    return result;
  };
  const previous = layer(global, before);
  const next = layer(nextGlobal, after);
  const changes: LinkChange[] = [];
  for (const [key, link] of previous) if (!next.has(key)) changes.push({ ...link, present: false });
  for (const [key, link] of next) if (JSON.stringify(previous.get(key)) !== JSON.stringify(link)) changes.push(link);
  return changes;
}
