import type { ProfileDefinition } from '../compiler/ir.ts';

const profile = '<https://rezics.com/definition/rating-question-presentation-v2>';

export const ratingQuestionPresentationReviewedProfile = {
  id: 'rating-question-presentation-v2',
  comments: [
    'An independently versioned question presentation for one RatingContext and BCP 47 language.',
    'The authored question, Context head, manifest and observations never advance with presentation wording.',
    'One editorial head and an optional last reviewed head per Context/language; drafts retain the reviewed text.',
  ],
  prefixes: [
    ['sh', 'http://www.w3.org/ns/shacl#'],
    ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['xsd', 'http://www.w3.org/2001/XMLSchema#'],
    ['rv', 'https://rezics.com/vocab/'],
  ],
  layout: 'compact',
  binding: {
    required: ['presentation', 'revision', 'context', 'language'],
    roles: ['presentation', 'revision'],
    demandedBy: ['rv:RatingQuestionPresentationV2', 'rv:RatingQuestionPresentationV2Revision'],
  },
  shapes: [
    {
      iri: 'https://rezics.com/definition/rating-question-presentation-v2/presentation-shape',
      canonical: { types: ['rv:RatingQuestionPresentationV2'] },
      closed: true,
      properties: [
        { path: 'rdf:type', hasValue: 'rv:RatingQuestionPresentationV2', maxCount: 1 },
        {
          path: 'rv:questionPresentationHead',
          minCount: 1,
          maxCount: 1,
          class: 'rv:RatingQuestionPresentationV2Revision',
        },
        { path: 'rv:questionPresentationReviewedHead', maxCount: 1, nodeKind: 'sh:IRI' },
        { path: 'rv:presentationContext', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
        {
          path: 'rv:presentationLanguage',
          minCount: 1,
          maxCount: 1,
          datatype: 'xsd:string',
          maxLength: 255,
        },
      ],
    },
    {
      iri: 'https://rezics.com/definition/rating-question-presentation-v2/revision-shape',
      canonical: { types: ['rv:RatingQuestionPresentationV2Revision'] },
      closed: true,
      properties: [
        {
          path: 'rdf:type',
          in: ['rv:RatingQuestionPresentationV2Revision', 'rv:RevisionAnchor'],
          minCount: 2,
          maxCount: 2,
        },
        {
          path: 'rv:component',
          minCount: 1,
          maxCount: 1,
          class: 'rv:RatingQuestionPresentationV2',
        },
        { path: 'rv:predecessor', maxCount: 1, nodeKind: 'sh:IRI' },
        { path: 'rv:presentationContext', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
        {
          path: 'rv:presentationLanguage',
          minCount: 1,
          maxCount: 1,
          datatype: 'xsd:string',
          maxLength: 255,
        },
        {
          path: 'rv:question',
          minCount: 1,
          maxCount: 1,
          datatype: 'rdf:langString',
          minLength: 3,
          maxLength: 120,
        },
        { path: 'rv:source', minCount: 1, maxCount: 1, datatype: 'xsd:string', maxLength: 2048 },
        { path: 'rv:licence', minCount: 1, maxCount: 1, datatype: 'xsd:string', maxLength: 2048 },
        { path: 'rv:reviewStatus', minCount: 1, maxCount: 1, in: ['rv:Draft', 'rv:Reviewed'] },
        { path: 'rv:operation', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
        { path: 'rv:manifest', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
        { path: 'rv:modelGeneration', minCount: 1, maxCount: 1, class: 'rv:ModelGeneration' },
        { path: 'rv:modelRevision', hasValue: profile, maxCount: 1 },
        { path: 'rv:shapeRevision', hasValue: profile, maxCount: 1 },
        { path: 'rv:datasetId', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
        { path: 'rv:dataEpoch', minCount: 1, maxCount: 1, datatype: 'xsd:string' },
        { path: 'rv:sequence', minCount: 1, maxCount: 1, datatype: 'xsd:integer', minInclusive: 1 },
      ],
    },
  ],
} as const satisfies ProfileDefinition;
