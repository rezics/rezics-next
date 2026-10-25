import { routeOf } from '../route/route.ts';

export type LinkChange = { property: string; statement: string; target: string; present: boolean };

type LinkFact = {
  kind: string;
  operation: string;
  property: string | null;
  statement_id: string | null;
  body: unknown;
};

const linkKey = (link: { property: string; statement: string; target: string }) =>
  `${link.property}\0${link.statement}\0${link.target}`;

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
): Map<string, { property: string; statement: string; target: string }> {
  const links = new Map<string, { property: string; statement: string; target: string }>();
  for (const fact of facts) {
    const link = linkTarget(fact, dataTypes);
    if (link) links.set(linkKey(link), link);
  }
  return links;
}

/** Preferred and normal item statements shown by the Global view. Ranks are not part of a link. */
export function linkChanges(
  before: readonly LinkFact[],
  after: readonly LinkFact[],
  dataTypes: Readonly<Record<string, string>>,
): LinkChange[] {
  const previous = linksOf(before, dataTypes);
  const next = linksOf(after, dataTypes);
  const changes: LinkChange[] = [];
  for (const [key, link] of previous) {
    if (!next.has(key)) changes.push({ ...link, present: false });
  }
  for (const [key, link] of next) {
    if (!previous.has(key)) changes.push({ ...link, present: true });
  }
  changes.sort((left, right) => {
    if (left.property !== right.property) return left.property < right.property ? -1 : 1;
    if (left.statement !== right.statement) return left.statement < right.statement ? -1 : 1;
    if (left.target !== right.target) return left.target < right.target ? -1 : 1;
    return 0;
  });
  return changes;
}
