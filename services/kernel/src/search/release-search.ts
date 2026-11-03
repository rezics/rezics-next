import { admitFilter, FilterError, type FilterDocument, type FilterRange, type FilterRelease } from '@rezics/filter';

export type ReleaseProducerRole = 'developer' | 'publisher';

export type ReleaseSearchCriteria = {
  platform?: string;
  languages?: readonly string[];
  date?: Extract<FilterRange, { type: 'time' }>;
  ageRating?: Exclude<FilterRange, { type: 'time' }>;
  producer?: { role: ReleaseProducerRole; subject: string };
};

const producerProperties: Record<ReleaseProducerRole, string> = {
  developer: 'wdt:P178',
  publisher: 'schema:publisher',
};

function requireFacet(release: FilterRelease, type: string, property: string): void {
  if (!release.types[type]?.facets?.includes(property))
    throw new FilterError('unsupported_query', '/releaseType', 'unsupported');
}

function distinct(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/** Build the release operands from one active released subtype and preserve platform-language association. */
export function buildReleaseSearchFilter(
  release: FilterRelease,
  releaseType: string,
  criteria: ReleaseSearchCriteria,
): FilterDocument {
  requireFacet(release, releaseType, 'schema:exampleOfWork');
  const clauses: FilterDocument[] = [{ type: { in: [releaseType] } }];

  if (criteria.platform !== undefined) {
    requireFacet(release, releaseType, 'schema:gamePlatform');
    const languages = distinct(criteria.languages ?? []);
    const qualifiers = languages.length ? [{ property: 'schema:inLanguage', in: languages }] : undefined;
    if (qualifiers && !release.properties['schema:gamePlatform']?.qualifiers?.includes('schema:inLanguage'))
      throw new FilterError('unsupported_query', '/platform/languages', 'unsupported');
    clauses.push({
      statement: {
        property: 'schema:gamePlatform',
        in: [criteria.platform],
        ...(qualifiers ? { qualifiers } : {}),
      },
    });
  } else if (criteria.languages?.length) {
    requireFacet(release, releaseType, 'schema:inLanguage');
    clauses.push({ statement: { property: 'schema:inLanguage', in: distinct(criteria.languages) } });
  }

  if (criteria.date !== undefined) {
    requireFacet(release, releaseType, 'schema:datePublished');
    clauses.push({ statement: { property: 'schema:datePublished', range: criteria.date } });
  }

  if (criteria.ageRating !== undefined) {
    requireFacet(release, releaseType, 'wdt:P2899');
    clauses.push({ statement: { property: 'wdt:P2899', range: criteria.ageRating } });
  }

  if (criteria.producer !== undefined) {
    const property = producerProperties[criteria.producer.role];
    requireFacet(release, releaseType, property);
    clauses.push({ statement: { property, in: [criteria.producer.subject] } });
  }

  return admitFilter({ and: clauses }, release);
}
