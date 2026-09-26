import type { ProfileDefinition, Term } from '../compiler/ir.ts';

const fixed = (path: `rv:${string}`, hasValue: Term) => ({
  path, hasValue, maxCount: 1, hasValueBeforeMaxCount: true,
});

/** Fixed Global policy shared by the Context and the observations that name it. */
export const globalRatingContextPolicy = [
  { path: 'rdf:type', hasValue: 'rv:GlobalRatingContext' },
  fixed('rv:contextState', 'rv:Active'),
  { path: 'rv:realm', maxCount: 0 },
  fixed('rv:ratingPopulationOwner', '<https://rezics.com/id/00000000-0000-8000-8000-676c6f62616c>'),
  fixed('rv:targetGrain', 'rv:MainVersion'),
  { ...fixed('rv:ratingScaleMin', '1'), datatype: 'xsd:integer' },
  { ...fixed('rv:ratingScaleMax', '5'), datatype: 'xsd:integer' },
  fixed('rv:ratingCadence', '<https://rezics.com/definition/rating-standing-v1>'),
  fixed('rv:ratingPopulationPolicy', '<https://rezics.com/definition/rating-global-account-principal-population-v1>'),
  fixed('rv:ratingAggregationPolicy', '<https://rezics.com/definition/rating-latest-per-rater-mean-v1>'),
] as const;

export const globalRatingStandingContextProfile = {
  id: 'global-rating-standing-context-v1',
  comments: [
    'Global rating question outside every Realm: its own 1-5 scale and Account population.',
    'It never carries rv:RatingContext or rv:realm, so Realm shapes and reads cannot select it.',
  ],
  prefixes: [
    ['sh', 'http://www.w3.org/ns/shacl#'],
    ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['xsd', 'http://www.w3.org/2001/XMLSchema#'],
    ['rv', 'https://rezics.com/vocab/'],
  ],
  layout: 'compact',
  shapes: [
    {
      iri: 'https://rezics.com/definition/global-rating-standing-context-v1/context-shape',
      canonical: { types: ['rv:GlobalRatingContext'] },
      properties: [
        ...globalRatingContextPolicy,
        { path: 'rv:question', minCount: 1, maxCount: 1, datatype: 'rdf:langString',
          languageIn: ['en'], minLength: 3, maxLength: 120 },
        { path: 'rv:head', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
      ],
    },
  ],
  binding: { required: ['context', 'question'], roles: ['context'], demandedBy: ['rv:GlobalRatingContext'] },
} as const satisfies ProfileDefinition;
