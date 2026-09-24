import type { ProfileDefinition, Term } from '../compiler/ir.ts';

const fixed = (path: `rv:${string}`, hasValue: Term, breaks: number[] = []) => ({
  path, hasValue, maxCount: 1, hasValueBeforeMaxCount: true,
  ...(breaks.length ? { lineBreaks: breaks.map(after => ({ after, indent: 8 })) } : {}),
});
const requiredClass = (path: `rv:${string}`, term: Term) => ({ path, minCount: 1, maxCount: 1,
  class: term, lineBreaks: [{ after: 3, indent: 8 }] });

export const realmStandingRatingObservationProfile = {
  id: 'realm-standing-rating-observation-v1',
  comments: [
    'One Account-principal standing slot for one MainVersion and Realm question.',
    'The slot is opaque; principal identity belongs to Access, not public RDF.',
  ],
  prefixes: [
    ['sh', 'http://www.w3.org/ns/shacl#'],
    ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['xsd', 'http://www.w3.org/2001/XMLSchema#'],
    ['schema', 'https://schema.org/'],
    ['rv', 'https://rezics.com/vocab/'],
  ],
  layout: 'compact',
  shapes: [
    {
      iri: 'https://rezics.com/definition/realm-standing-rating-observation-v1/realm-shape',
      properties: [
        { path: 'rdf:type', hasValue: 'rv:Realm' },
        fixed('rv:realmState', 'rv:Active'),
        { path: 'rv:ratingContext', minCount: 1, nodeKind: 'sh:IRI' },
      ],
    },
    {
      iri: 'https://rezics.com/definition/realm-standing-rating-observation-v1/context-shape',
      properties: [
        { path: 'rdf:type', hasValue: 'rv:RatingContext' },
        fixed('rv:contextState', 'rv:Active'),
        { path: 'rv:realm', minCount: 1, maxCount: 1, class: 'rv:Realm' },
        fixed('rv:targetGrain', 'rv:MainVersion'),
        fixed('rv:ratingScaleMin', '1'),
        fixed('rv:ratingScaleMax', '10'),
        fixed('rv:ratingCadence', '<https://rezics.com/definition/rating-standing-v1>', [1]),
        fixed('rv:ratingPopulationPolicy', '<https://rezics.com/definition/rating-account-principal-population-v1>', [1, 2]),
        fixed('rv:ratingAggregationPolicy', '<https://rezics.com/definition/rating-latest-per-rater-mean-v1>', [1, 2]),
      ],
    },
    {
      iri: 'https://rezics.com/definition/realm-standing-rating-observation-v1/work-shape',
      properties: [
        { path: 'rdf:type', hasValue: 'schema:CreativeWork' },
        requiredClass('rv:mainVersion', 'rv:MainVersion'),
      ],
    },
    {
      iri: 'https://rezics.com/definition/realm-standing-rating-observation-v1/main-shape',
      properties: [
        { path: 'rdf:type', hasValue: 'rv:MainVersion' },
        requiredClass('rv:work', 'schema:CreativeWork'),
      ],
    },
    {
      iri: 'https://rezics.com/definition/realm-standing-rating-observation-v1/observation-shape',
      properties: [
        { path: 'rdf:type', hasValue: 'rv:RatingObservation' },
        requiredClass('rv:ratingContext', 'rv:RatingContext'),
        requiredClass('rv:targetMainVersion', 'rv:MainVersion'),
        { path: 'rv:ratingSlot', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI',
          lineBreaks: [{ after: 3, indent: 8 }] },
        requiredClass('rv:observationHead', 'rv:RatingObservationRevision'),
      ],
    },
    {
      iri: 'https://rezics.com/definition/realm-standing-rating-observation-v1/revision-shape',
      properties: [
        { path: 'rdf:type', hasValue: 'rv:RatingObservationRevision' },
        requiredClass('rv:observation', 'rv:RatingObservation'),
        { path: 'rv:ratingAvailability', minCount: 1, maxCount: 1,
          in: ['rv:Available', 'rv:Withdrawn'], lineBreaks: [{ after: 3, indent: 8 }] },
        ...(['rv:evaluatedAt', 'rv:submittedAt', 'rv:originalSubmissionAt', 'rv:revisedAt'] as const)
          .map(path => ({ path, minCount: 1, maxCount: 1, datatype: 'xsd:dateTime' as const,
            lineBreaks: [{ after: 3, indent: 8 }] })),
        { path: 'rv:predecessor', maxCount: 1, class: 'rv:RatingObservationRevision',
          lineBreaks: [{ after: 2, indent: 8 }] },
      ],
      or: [
        [
          { path: 'rv:ratingAvailability', hasValue: 'rv:Available' },
          { path: 'rv:ratingValue', minCount: 1, maxCount: 1, datatype: 'xsd:integer',
            minInclusive: 1, maxInclusive: 10, lineBreaks: [{ after: 3, indent: 12 }] },
        ],
        [
          { path: 'rv:ratingAvailability', hasValue: 'rv:Withdrawn' },
          { path: 'rv:ratingValue', maxCount: 0 },
        ],
      ],
    },
  ],
} as const satisfies ProfileDefinition;
