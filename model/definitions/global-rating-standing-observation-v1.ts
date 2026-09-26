import type { ProfileDefinition, Term } from '../compiler/ir.ts';
import { globalRatingContextPolicy } from './global-rating-standing-context-v1.ts';

const requiredClass = (path: `rv:${string}`, term: Term) => ({ path, minCount: 1, maxCount: 1, class: term });

export const globalRatingStandingObservationProfile = {
  id: 'global-rating-standing-observation-v1',
  comments: [
    'One Account-principal standing slot for one MainVersion and Global question, valued 1-5.',
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
      iri: 'https://rezics.com/definition/global-rating-standing-observation-v1/context-shape',
      properties: globalRatingContextPolicy,
    },
    {
      iri: 'https://rezics.com/definition/global-rating-standing-observation-v1/work-shape',
      properties: [
        { path: 'rdf:type', hasValue: 'schema:CreativeWork' },
        requiredClass('rv:mainVersion', 'rv:MainVersion'),
      ],
    },
    {
      iri: 'https://rezics.com/definition/global-rating-standing-observation-v1/main-shape',
      properties: [
        { path: 'rdf:type', hasValue: 'rv:MainVersion' },
        requiredClass('rv:work', 'schema:CreativeWork'),
      ],
    },
    {
      iri: 'https://rezics.com/definition/global-rating-standing-observation-v1/observation-shape',
      canonical: { types: ['rv:GlobalRatingObservation'] },
      properties: [
        { path: 'rdf:type', hasValue: 'rv:GlobalRatingObservation' },
        requiredClass('rv:ratingContext', 'rv:GlobalRatingContext'),
        requiredClass('rv:targetMainVersion', 'rv:MainVersion'),
        { path: 'rv:ratingSlot', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
        requiredClass('rv:observationHead', 'rv:GlobalRatingObservationRevision'),
      ],
    },
    {
      iri: 'https://rezics.com/definition/global-rating-standing-observation-v1/revision-shape',
      canonical: { types: ['rv:GlobalRatingObservationRevision'] },
      properties: [
        { path: 'rdf:type', hasValue: 'rv:GlobalRatingObservationRevision' },
        requiredClass('rv:observation', 'rv:GlobalRatingObservation'),
        { path: 'rv:ratingAvailability', minCount: 1, maxCount: 1, in: ['rv:Available', 'rv:Withdrawn'] },
        ...(['rv:evaluatedAt', 'rv:submittedAt', 'rv:originalSubmissionAt', 'rv:revisedAt'] as const)
          .map(path => ({ path, minCount: 1, maxCount: 1, datatype: 'xsd:dateTime' as const })),
        { path: 'rv:predecessor', maxCount: 1, class: 'rv:GlobalRatingObservationRevision' },
      ],
      or: [
        [
          { path: 'rv:ratingAvailability', hasValue: 'rv:Available' },
          { path: 'rv:ratingValue', minCount: 1, maxCount: 1, datatype: 'xsd:integer',
            minInclusive: 1, maxInclusive: 5 },
        ],
        [
          { path: 'rv:ratingAvailability', hasValue: 'rv:Withdrawn' },
          { path: 'rv:ratingValue', maxCount: 0 },
        ],
      ],
    },
  ],
  binding: {
    required: ['context', 'work', 'main', 'slot', 'observation', 'revision', 'availability'],
    optional: ['value', 'predecessor'],
    roles: ['context', 'work', 'main', 'observation', 'revision'],
    demandedBy: ['rv:GlobalRatingObservation', 'rv:GlobalRatingObservationRevision'],
  },
} as const satisfies ProfileDefinition;
