import type { Release } from '@rezics/definitions';
import { holderKeys, positionKey } from './link-keys.ts';
import type { FactRow } from './item.ts';
import { routeOf } from '../route/route.ts';

export type LinkChange = {
  property: string;
  statement: string;
  target: string;
  present: boolean;
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

const linkKey = (link: { property: string; statement: string; target: string }) =>
  `${link.property}\0${link.statement}\0${link.target}\0${(link as LinkChange).filter_value ?? ''}`;

function linkTarget(
  fact: LinkFact,
  dataTypes: Readonly<Record<string, string>>,
): { property: string; statement: string; target: string } | null {
  if (fact.kind !== 'statement' || fact.operation !== 'assert' || fact.property === null || fact.statement_id === null)
    return null;
  if (dataTypes[fact.property] !== 'wikibase-item') return null;
  if (fact.body === null || typeof fact.body !== 'object' || Array.isArray(fact.body)) return null;
  const body = fact.body as { rank?: unknown; value?: unknown };
  if (body.rank !== 'normal' && body.rank !== 'preferred') return null;
  if (body.value === null || typeof body.value !== 'object' || Array.isArray(body.value)) return null;
  const value = body.value as { type?: unknown; content?: unknown };
  if (value.type !== 'value' || typeof value.content !== 'string' || routeOf(value.content) === null) return null;
  return { property: fact.property, statement: fact.statement_id, target: value.content };
}

function linksOf(
  facts: readonly LinkFact[],
  dataTypes: Readonly<Record<string, string>>,
  metadata?: { release: Release; type: string },
): Map<string, Omit<LinkChange, 'present'>> {
  const links = new Map<string, Omit<LinkChange, 'present'>>();
  const holder = metadata ? holderKeys(facts as FactRow[], metadata.type) : null;
  for (const fact of facts) {
    const link = linkTarget(fact, dataTypes);
    if (!link) continue;
    if (!metadata || !holder) {
      links.set(linkKey(link), link);
      continue;
    }
    const relation = metadata.release.properties[link.property]?.relation;
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
    const values = new Set(['00000000-0000-0000-0000-000000000000']);
    for (const qualifier of qualifiers) {
      if (
        qualifier.property === relation?.filter &&
        qualifier.value.type === 'value' &&
        typeof qualifier.value.content === 'string' &&
        routeOf(qualifier.value.content) !== null
      )
        values.add(qualifier.value.content);
    }
    for (const filter_value of values) {
      const keyed = { ...link, source_type: holder.source_type, order_key, filter_value };
      links.set(linkKey(keyed), keyed);
    }
  }
  return links;
}

/** Preferred and normal item statements shown by the Global view. Ranks are not part of a link. */
export function linkChanges(
  before: readonly LinkFact[],
  after: readonly LinkFact[],
  dataTypes: Readonly<Record<string, string>>,
  metadata?: { release: Release; type: string; beforeType?: string; refresh?: boolean },
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
    if (left.target !== right.target) return left.target < right.target ? -1 : 1;
    return 0;
  });
  return changes;
}
