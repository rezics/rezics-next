import type { ProfileDefinition } from '../compiler/ir.ts';

/** The Context's question revision stays fixed; only this independent head moves. */
export const ratingAggregateDefaultPolicyProfile = {
  id: 'rating-aggregate-default-policy-v1',
  comments: ['An exact successor for an experience Context aggregate default.'],
  prefixes: [
    ['sh', 'http://www.w3.org/ns/shacl#'],
    ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['rv', 'https://rezics.com/vocab/'],
  ],
  layout: 'compact',
  shapes: [
    {
      iri: 'https://rezics.com/definition/rating-aggregate-default-policy-v1/context-shape',
      properties: [
        { path: 'rdf:type', hasValue: 'rv:RatingContext' },
        { path: 'rdf:type', hasValue: 'rv:ExperienceRatingContext' },
        { path: 'rv:contextState', hasValue: 'rv:Active', maxCount: 1 },
        { path: 'rv:head', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
        { path: 'rv:ratingPolicyHead', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
        { path: 'rv:ratingAggregationPolicy', hasValue: '<https://rezics.com/definition/rating-latest-per-rater-mean-v1>', maxCount: 1 },
        { path: 'rv:ratingCadence', hasValue: '<https://rezics.com/definition/rating-experience-v1>', maxCount: 1 },
      ],
    },
    {
      iri: 'https://rezics.com/definition/rating-aggregate-default-policy-v1/revision-shape',
      properties: [
        { path: 'rdf:type', hasValue: 'rv:RatingPolicyRevision' },
        { path: 'rdf:type', hasValue: 'rv:RevisionAnchor' },
        { path: 'rv:component', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
        { path: 'rv:contextRevision', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
        { path: 'rv:predecessor', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
        { path: 'rv:ratingAggregationPolicy', minCount: 1, maxCount: 1,
          in: ['<https://rezics.com/definition/rating-latest-per-rater-mean-v1>',
            '<https://rezics.com/definition/rating-mean-per-rater-v1>',
            '<https://rezics.com/definition/rating-pooled-observation-mean-v1>'] },
        { path: 'rv:modelRevision', hasValue: '<https://rezics.com/definition/rating-aggregate-default-policy-v1>', maxCount: 1 },
        { path: 'rv:manifest', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
      ],
    },
  ],
} as const satisfies ProfileDefinition;
