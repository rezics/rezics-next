import type { ProfileDefinition } from '../compiler/ir.ts';

const definition = '<https://rezics.com/definition/content-publication-v1>' as const;
const uuid = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const oneIri = (path: `rv:${string}`) => ({ path, minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' as const });
const oneString = (path: `rv:${string}`) => ({ path, minCount: 1, maxCount: 1, datatype: 'xsd:string' as const });

export const contentPublicationProfile = {
  id: 'content-publication-v1',
  comments: [
    'One exact Content revision pinned by a guarded graph publication decision.',
    'This record does not disclose body bytes or activate a public search unit.',
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
      iri: 'https://rezics.com/definition/content-publication-v1/variant-shape',
      properties: [
        { path: 'rdf:type', hasValue: 'rv:ContentVariant', maxCount: 1 },
        { path: 'rv:resource', minCount: 1, maxCount: 1, class: 'schema:CreativeWork' },
        oneIri('rv:contentPublicationHead'),
      ],
    },
    {
      iri: 'https://rezics.com/definition/content-publication-v1/decision-shape',
      properties: [
        { path: 'rdf:type', minCount: 2, maxCount: 2,
          in: ['rv:ContentPublicationDecision', 'rv:RevisionAnchor'] },
        oneIri('rv:component'),
        { ...oneIri('rv:operation'), pattern: '^urn:rezics:operation:[0-9a-f]{64}$' },
        { ...oneIri('rv:contentRevision'),
          pattern: '^urn:rezics:content:revision:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' },
        { ...oneString('rv:contentPreparation'), minLength: 1, maxLength: 200 },
        oneIri('rv:resource'),
        { ...oneString('rv:byteDigest'), pattern: '^[0-9a-f]{64}$' },
        { path: 'rv:contentFormat', hasValue: '"rezics-content-json-v1"', maxCount: 1,
          datatype: 'xsd:string' },
        { ...oneString('rv:contentModel'), minLength: 1, maxLength: 300 },
        { path: 'rv:contentLanguageKind', minCount: 1, maxCount: 1,
          in: ['"tag"', '"missing"', '"und"', '"mul"', '"zxx"'] },
        { path: 'rv:contentLanguage', maxCount: 1, datatype: 'xsd:string',
          pattern: '^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$' },
        { path: 'rv:contentDirection', minCount: 1, maxCount: 1,
          in: ['"ltr"', '"rtl"', '"none"'] },
        { ...oneString('rv:ownerDataEpoch'), pattern: uuid },
        { ...oneString('rv:ownerSequence'), pattern: '^(0|[1-9][0-9]*)$' },
        { path: 'rv:modelRevision', hasValue: definition, maxCount: 1 },
        { path: 'rv:shapeRevision', hasValue: definition, maxCount: 1 },
        { path: 'rv:datasetId', hasValue: '<urn:rezics:dataset:product>', maxCount: 1 },
        { ...oneString('rv:dataEpoch'), pattern: uuid },
        { path: 'rv:sequence', minCount: 1, maxCount: 1,
          datatype: 'xsd:integer', minInclusive: 1 },
      ],
      or: [
        [
          { path: 'rv:contentLanguageKind', hasValue: '"tag"' },
          { path: 'rv:contentLanguage', minCount: 1, maxCount: 1,
            datatype: 'xsd:string' },
        ],
        [
          { path: 'rv:contentLanguageKind', minCount: 1, maxCount: 1,
            in: ['"missing"', '"und"', '"mul"', '"zxx"'] },
          { path: 'rv:contentLanguage', maxCount: 0 },
        ],
      ],
    },
  ],
} as const satisfies ProfileDefinition;
