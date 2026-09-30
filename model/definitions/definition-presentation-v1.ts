import type { ProfileDefinition } from '../compiler/ir.ts';

const profile = '<https://rezics.com/definition/definition-presentation-v1>';

/** Registry bindings suffice: this owner introduces no Java policy case. */
export const definitionPresentationProfile = {
  id: 'definition-presentation-v1',
  comments: [
    'An independently versioned, language-specific viewing direction of an exact relation meaning.',
    'Wording revisions never advance definitionHead. One current presentation per exact meaning/direction/language.',
    'Plural and grammatical forms are structured data; no executable sentence template is admitted.',
  ],
  prefixes: [
    ['sh', 'http://www.w3.org/ns/shacl#'],
    ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['xsd', 'http://www.w3.org/2001/XMLSchema#'],
    ['rv', 'https://rezics.com/vocab/'],
  ],
  layout: 'compact',
  binding: {
    required: [
      'presentation',
      'revision',
      'definition',
      'meaningRevision',
      'fromRole',
      'toRole',
      'language',
    ],
    roles: ['presentation', 'revision'],
    demandedBy: ['rv:DefinitionPresentation', 'rv:PresentationRevision'],
  },
  shapes: [
    {
      iri: 'https://rezics.com/definition/definition-presentation-v1/presentation-shape',
      canonical: { types: ['rv:DefinitionPresentation'] },
      closed: true,
      properties: [
        { path: 'rdf:type', hasValue: 'rv:DefinitionPresentation', maxCount: 1 },
        { path: 'rv:presentationHead', minCount: 1, maxCount: 1, class: 'rv:PresentationRevision' },
        {
          path: 'rv:presentationDefinition',
          minCount: 1,
          maxCount: 1,
          class: 'rv:SemanticDefinition',
        },
        { path: 'rv:meaningRevision', minCount: 1, maxCount: 1, class: 'rv:DefinitionRevision' },
        { path: 'rv:fromRole', minCount: 1, maxCount: 1, datatype: 'xsd:string' },
        { path: 'rv:toRole', minCount: 1, maxCount: 1, datatype: 'xsd:string' },
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
      iri: 'https://rezics.com/definition/definition-presentation-v1/revision-shape',
      canonical: { types: ['rv:PresentationRevision'] },
      closed: true,
      properties: [
        {
          path: 'rdf:type',
          in: ['rv:PresentationRevision', 'rv:RevisionAnchor'],
          minCount: 2,
          maxCount: 2,
        },
        { path: 'rv:component', minCount: 1, maxCount: 1, class: 'rv:DefinitionPresentation' },
        { path: 'rv:predecessor', maxCount: 1, class: 'rv:PresentationRevision' },
        {
          path: 'rv:presentationDefinition',
          minCount: 1,
          maxCount: 1,
          class: 'rv:SemanticDefinition',
        },
        { path: 'rv:meaningRevision', minCount: 1, maxCount: 1, class: 'rv:DefinitionRevision' },
        { path: 'rv:fromRole', minCount: 1, maxCount: 1, datatype: 'xsd:string' },
        { path: 'rv:toRole', minCount: 1, maxCount: 1, datatype: 'xsd:string' },
        {
          path: 'rv:presentationLanguage',
          minCount: 1,
          maxCount: 1,
          datatype: 'xsd:string',
          maxLength: 255,
        },
        { path: 'rv:noun', minCount: 1, maxCount: 1, datatype: 'xsd:string', maxLength: 512 },
        { path: 'rv:heading', minCount: 1, maxCount: 1, datatype: 'xsd:string', maxLength: 512 },
        {
          path: 'rv:pluralForms',
          minCount: 1,
          maxCount: 1,
          datatype: 'xsd:string',
          maxLength: 8192,
        },
        {
          path: 'rv:grammaticalForms',
          minCount: 1,
          maxCount: 1,
          datatype: 'xsd:string',
          maxLength: 32768,
        },
        { path: 'rv:source', minCount: 1, maxCount: 1, datatype: 'xsd:string' },
        { path: 'rv:licence', minCount: 1, maxCount: 1, datatype: 'xsd:string' },
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
