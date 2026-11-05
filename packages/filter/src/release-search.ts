import {
  admitFilter,
  facetProperties,
  FilterError,
  type FilterDocument,
  type FilterRange,
  type FilterRelease,
} from './filter.ts';

export type ReleaseProducerRole = 'developer' | 'publisher';

export type ReleaseSearchCriteria = {
  platform?: string;
  languages?: readonly string[];
  date?: Extract<FilterRange, { type: 'time' }>;
  ageRating?: Exclude<FilterRange, { type: 'time' }>;
  developer?: string;
  publisher?: string;
  /** A role-specific operand retained for existing callers; never a generic producer property. */
  producer?: { role: ReleaseProducerRole; subject: string };
};

const producerProperties: Record<ReleaseProducerRole, string> = {
  developer: 'wdt:P178',
  publisher: 'schema:publisher',
};

export type ReleaseSearchControls = {
  releaseType: string;
  /** The shared admission roster, including inherited facets with released definitions. */
  facets: string[];
  platform: { property: 'schema:gamePlatform'; languageQualifier: 'schema:inLanguage' | null } | null;
  language: { property: 'schema:inLanguage' } | null;
  date: { property: 'schema:datePublished' } | null;
  ageRating: { property: 'wdt:P2899'; units: string[] } | null;
  producers: { role: ReleaseProducerRole; property: string }[];
};

/** Derive capabilities, never option values or population completeness, from one active release. */
export function admittedReleaseSearchControls(
  release: FilterRelease,
  releaseType: string,
): ReleaseSearchControls | null {
  if (!Object.hasOwn(release.types, releaseType)) return null;
  const facets = facetProperties(release, [releaseType]).filter((property) =>
    Object.hasOwn(release.properties, property),
  );
  const admits = (property: string, datatype: string) =>
    facets.includes(property) && release.properties[property]?.datatype === datatype;
  // A property occurrence elsewhere in the catalogue does not make this type a release operand.
  if (!admits('schema:exampleOfWork', 'wikibase-item')) return null;
  const language = release.properties['schema:inLanguage'];
  const languageCode = language?.datatype === 'string' && Boolean(language.value?.pattern);
  const units = release.properties['wdt:P2899']?.units ?? [];
  return {
    releaseType,
    facets,
    platform: admits('schema:gamePlatform', 'wikibase-item')
      ? {
          property: 'schema:gamePlatform',
          languageQualifier:
            languageCode && release.properties['schema:gamePlatform']?.qualifiers?.includes('schema:inLanguage')
              ? 'schema:inLanguage'
              : null,
        }
      : null,
    language: admits('schema:inLanguage', 'string') && languageCode ? { property: 'schema:inLanguage' } : null,
    date: admits('schema:datePublished', 'time') ? { property: 'schema:datePublished' } : null,
    ageRating:
      admits('wdt:P2899', 'quantity') && units.length ? { property: 'wdt:P2899', units: distinct(units) } : null,
    producers: (['developer', 'publisher'] as const).flatMap((role) => {
      const property = producerProperties[role];
      return admits(property, 'wikibase-item') ? [{ role, property }] : [];
    }),
  };
}

/** No fixed subtype list or inferred admissions from research inventories. */
export function admittedReleaseSearchTypes(release: FilterRelease): string[] {
  return Object.keys(release.types).filter((type) => admittedReleaseSearchControls(release, type) !== null);
}

/** Producer controls are available only when the active subtype admits their exact property. */
export function admittedReleaseProducerRoles(release: FilterRelease, releaseType: string): ReleaseProducerRole[] {
  return admittedReleaseSearchControls(release, releaseType)?.producers.map(({ role }) => role) ?? [];
}

function unsupported(pointer: string): never {
  throw new FilterError('unsupported_query', pointer, 'unsupported');
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
  const controls = admittedReleaseSearchControls(release, releaseType);
  if (!controls) unsupported('/releaseType');
  const clauses: FilterDocument[] = [{ type: { in: [releaseType] } }];

  if (criteria.platform !== undefined) {
    if (!controls.platform) unsupported('/platform');
    const languages = distinct(criteria.languages ?? []);
    const qualifiers = languages.length ? [{ property: 'schema:inLanguage', in: languages }] : undefined;
    if (qualifiers && !controls.platform.languageQualifier) unsupported('/platform/languages');
    clauses.push({
      statement: {
        property: 'schema:gamePlatform',
        in: [criteria.platform],
        ...(qualifiers ? { qualifiers } : {}),
      },
    });
  } else if (criteria.languages?.length) {
    if (!controls.language) unsupported('/languages');
    clauses.push({ statement: { property: 'schema:inLanguage', in: distinct(criteria.languages) } });
  }

  if (criteria.date !== undefined) {
    if (!controls.date) unsupported('/date');
    clauses.push({ statement: { property: 'schema:datePublished', range: criteria.date } });
  }

  if (criteria.ageRating !== undefined) {
    if (!controls.ageRating) unsupported('/ageRating');
    clauses.push({ statement: { property: 'wdt:P2899', range: criteria.ageRating } });
  }

  const addProducer = (role: ReleaseProducerRole, subject: string, pointer: string) => {
    const control = controls.producers.find((control) => control.role === role);
    if (!control) unsupported(pointer);
    clauses.push({ statement: { property: control.property, in: [subject] } });
  };
  if (criteria.developer !== undefined) addProducer('developer', criteria.developer, '/developer');
  if (criteria.publisher !== undefined) addProducer('publisher', criteria.publisher, '/publisher');
  if (criteria.producer !== undefined) {
    addProducer(criteria.producer.role, criteria.producer.subject, '/producer/role');
  }

  return admitFilter({ and: clauses }, release);
}
