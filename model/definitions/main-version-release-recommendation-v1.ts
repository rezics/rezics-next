import type { ProfileDefinition } from '../compiler/ir.ts';

const definition = '<https://rezics.com/definition/main-package-release-recommendation-v1>' as const;

export const mainPackageReleaseRecommendationProfile = {
  id: 'main-package-release-recommendation-v1',
  comments: [
    'An editor-maintained, ordered set of software package release recommendations for one Main Version.',
    'A recommendation is a constraint or exact release, never a lock or artifact.',
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
      iri: 'https://rezics.com/definition/main-package-release-recommendation-v1/set-shape',
      properties: [
        { path: 'rdf:type', hasValue: 'rv:PackageReleaseRecommendationSet' },
        { path: 'rv:work', minCount: 1, maxCount: 1, class: 'schema:CreativeWork' },
        { path: 'rv:mainVersion', minCount: 1, maxCount: 1, class: 'rv:MainVersion' },
        { path: 'rv:predecessor', maxCount: 1, class: 'rv:RevisionAnchor' },
        { path: 'rv:recommendation', minCount: 0, maxCount: 16, class: 'rv:PackageReleaseRecommendation' },
        { path: 'rv:modelRevision', hasValue: definition, maxCount: 1 },
        { path: 'rv:shapeRevision', hasValue: definition, maxCount: 1 },
        { path: 'rv:datasetId', hasValue: '<urn:rezics:dataset:product>', maxCount: 1 },
        { path: 'rv:dataEpoch', minCount: 1, maxCount: 1, datatype: 'xsd:string',
          pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' },
        { path: 'rv:sequence', minCount: 1, maxCount: 1, datatype: 'xsd:integer', minInclusive: 1 },
      ],
    },
    {
      iri: 'https://rezics.com/definition/main-package-release-recommendation-v1/recommendation-shape',
      properties: [
        { path: 'rdf:type', hasValue: 'rv:PackageReleaseRecommendation', maxCount: 1 },
        { path: 'rv:ecosystem', minCount: 1, maxCount: 1, datatype: 'xsd:string',
          minLength: 1, maxLength: 32 },
        { path: 'rv:packageName', minCount: 1, maxCount: 1, datatype: 'xsd:string',
          minLength: 1, maxLength: 256 },
        { path: 'rv:selectorKind', minCount: 1, maxCount: 1, in: ['rv:VersionConstraint', 'rv:ExactRelease'] },
        { path: 'rv:selector', minCount: 1, maxCount: 1, datatype: 'xsd:string',
          minLength: 1, maxLength: 256 },
        { path: 'rv:position', minCount: 1, maxCount: 1, datatype: 'xsd:integer', minInclusive: 0,
          maxInclusive: 15 },
      ],
    },
  ],
} as const satisfies ProfileDefinition;
