import type { ProfileDefinition, Term } from '../compiler/ir.ts';

const fixed = (path: `rv:${string}`, hasValue: Term, wrap = false) => ({
  path, hasValue, maxCount: 1, hasValueBeforeMaxCount: true,
  ...(wrap ? { lineBreaks: [{ after: 1, indent: 18 }, { after: 2, indent: 18 }] } : {}),
});

export const realmStandingRatingContextProfile = {
  id: 'realm-standing-rating-context-v1',
  comments: ['First Realm rating question: one MainVersion standing opinion per Account principal.'],
  prefixes: [
    ['sh', 'http://www.w3.org/ns/shacl#'],
    ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['xsd', 'http://www.w3.org/2001/XMLSchema#'],
    ['rv', 'https://rezics.com/vocab/'],
  ],
  layout: 'compact',
  shapes: [
    {
      iri: 'https://rezics.com/definition/realm-standing-rating-context-v1/realm-shape',
      properties: [
        { path: 'rdf:type', hasValue: 'rv:Realm' },
        fixed('rv:realmState', 'rv:Active'),
        { path: 'rv:ratingContext', minCount: 1, nodeKind: 'sh:IRI' },
      ],
    },
    {
      iri: 'https://rezics.com/definition/realm-standing-rating-context-v1/context-shape',
      properties: [
        { path: 'rdf:type', hasValue: 'rv:RatingContext' },
        fixed('rv:contextState', 'rv:Active'),
        { path: 'rv:realm', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
        { path: 'rv:question', minCount: 1, maxCount: 1, datatype: 'rdf:langString',
          languageIn: ['en'], minLength: 3, maxLength: 120,
          lineBreaks: [{ after: 3, indent: 18 }, { after: 5, indent: 18 }] },
        fixed('rv:targetGrain', 'rv:MainVersion'),
        { ...fixed('rv:ratingScaleMin', '1'), datatype: 'xsd:integer',
          lineBreaks: [{ after: 3, indent: 18 }] },
        { ...fixed('rv:ratingScaleMax', '10'), datatype: 'xsd:integer',
          lineBreaks: [{ after: 3, indent: 18 }] },
        fixed('rv:ratingCadence', '<https://rezics.com/definition/rating-standing-v1>', true),
        fixed('rv:ratingPopulationPolicy', '<https://rezics.com/definition/rating-account-principal-population-v1>', true),
        fixed('rv:ratingAggregationPolicy', '<https://rezics.com/definition/rating-latest-per-rater-mean-v1>', true),
      ],
    },
  ],
} as const satisfies ProfileDefinition;
