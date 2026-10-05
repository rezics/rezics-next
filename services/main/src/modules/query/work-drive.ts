import type { ResourceCondition, ResourceCard } from './resource-contract.ts';

type Meaning = ReadonlyMap<string, { interpretations: string[] }>;

/** A positive single type (or one member of a conjunction) is a safe posting
 * superset. A union cannot be driven by just one of its members. */
export function resourceWorkType(
  conditions: readonly ResourceCondition[],
  definitions: readonly { type: string; base: string; default?: boolean }[],
): string | undefined {
  const types = new Set(
    definitions
      // The default Work anchor matches every Work, so it never narrows the postings.
      .filter((row) => row.base === 'work' && !row.default)
      .map((row) => row.type),
  );
  return conditions
    .filter(
      (row) =>
        row.facet === 'type' &&
        (row.operator === 'all' || (row.operator === 'any' && row.values.length === 1)),
    )
    .flatMap((row) => row.values)
    .find((type) => types.has(type));
}

/** Work types, the default anchor included, use the registry's base, including admitted extensions. The
 * live ownership/disclosure join remains authoritative after this index hint. */
export function resourceTypeKinds(
  conditions: readonly ResourceCondition[],
  definitions: readonly { type: string; base: string }[],
): ResourceCard['kind'][] {
  const owned: Record<string, ResourceCard['kind'][]> = {
    'http://www.w3.org/2004/02/skos/core#Concept': ['concept'],
    'https://rezics.com/vocab/Realm': ['realm'],
    'https://rezics.com/vocab/Zone': ['site'],
    'https://rezics.com/vocab/Space': ['space', 'realm', 'site'],
    'https://rezics.com/vocab/Agent': ['agent'],
    'https://rezics.com/vocab/Collection': ['collection'],
  };
  for (const definition of definitions)
    if (definition.base === 'work') owned[definition.type] = ['work'];
  let kinds: ResourceCard['kind'][] = [
    'work',
    'realm',
    'concept',
    'space',
    'site',
    'agent',
    'collection',
  ];
  for (const condition of conditions.filter(
    (row) => row.facet === 'type' && row.operator !== 'none',
  )) {
    if (condition.operator === 'all') {
      for (const type of condition.values)
        if (owned[type]) kinds = kinds.filter((kind) => owned[type]!.includes(kind));
    } else if (condition.values.every((type) => owned[type])) {
      kinds = kinds.filter((kind) => condition.values.some((type) => owned[type]!.includes(kind)));
    }
  }
  return kinds;
}

/** Drive a Work seek from the smallest positive Concept group. Conjunctions
 * admit any one group's postings as a superset; exclusions never drive a
 * positive index. Each group is a union of interpretation postings. Cached
 * Concept counts select the drive without aggregating the candidate corpus.
 * Other resource owners still evaluate their own topic relationships. */
export function resourceWorkDrive(
  conditions: readonly ResourceCondition[],
  meaning: Meaning,
  counts: ReadonlyMap<string, number>,
  maxTerms: number,
): string[] {
  const groups = conditions
    .filter((row) => row.facet === 'concept' && row.operator !== 'none')
    .flatMap((row) => (row.operator === 'all' ? row.values.map((value) => [value]) : [row.values]))
    .map((concepts) => ({
      terms: [
        ...new Set(concepts.flatMap((concept) => meaning.get(concept)?.interpretations ?? [])),
      ],
      count: concepts.reduce((sum, concept) => sum + (counts.get(concept) ?? 0), 0),
    }))
    .filter((group) => group.terms.length <= maxTerms)
    .sort((a, b) => a.count - b.count || a.terms.length - b.terms.length);
  return groups[0]?.terms ?? [''];
}
