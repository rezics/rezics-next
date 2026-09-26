import type { ProfileDefinition, PropertyDefinition } from '../compiler/ir.ts';

const definition = '<https://rezics.com/definition/collection-curation-v1>' as const;
const uuid = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const oneIri = (path: `rv:${string}`) => ({ path, minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' as const });

const position: readonly PropertyDefinition[] = [
  { path: 'rv:modelRevision', hasValue: definition, maxCount: 1 },
  { path: 'rv:shapeRevision', hasValue: definition, maxCount: 1 },
  { path: 'rv:datasetId', hasValue: '<urn:rezics:dataset:product>', maxCount: 1 },
  { path: 'rv:dataEpoch', minCount: 1, maxCount: 1, datatype: 'xsd:string', pattern: uuid },
  { path: 'rv:sequence', minCount: 1, maxCount: 1, datatype: 'xsd:integer', minInclusive: 1 },
];

export const collectionCurationProfile = {
  id: 'collection-curation-v1',
  comments: [
    'A Collection has its own identity and visibility; members are occurrences of its Structure.',
    'A Dynamic Collection is a versioned selection rule and stores no membership.',
    'A capture is a separate ordinary Collection pinned to one rule revision with an explicit coverage boundary.',
    'Visibility of a Collection never discloses a private member, its title or a member count.',
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
      iri: 'https://rezics.com/definition/collection-curation-v1/collection-shape',
      canonical: { types: ['rv:Collection'] },
      properties: [
        { path: 'rdf:type', hasValue: 'rv:Collection', maxCount: 1 },
        // A receipt-proven owner may await the second half of Structure bootstrap.
        { path: 'rv:structure', maxCount: 1, class: 'rv:Structure' },
        oneIri('rv:curator'),
        { path: 'rv:disclosure', minCount: 1, maxCount: 1, in: ['rv:Public', 'rv:Private'] },
        { path: 'rv:collectionState', minCount: 1, maxCount: 1, in: ['rv:Active', 'rv:Retired'] },
        { path: 'rv:collectionHead', minCount: 1, maxCount: 1, class: 'rv:CollectionRevision' },
        { path: 'schema:name', minCount: 1, datatype: 'rdf:langString', maxLength: 300,
          uniqueLang: true },
        { path: 'rv:collectionKind', minCount: 1, maxCount: 1,
          in: ['rv:StaticCollection', 'rv:CapturedCollection'] },
        { path: 'rv:capturedFrom', maxCount: 1, class: 'rv:DynamicCollectionRevision' },
        { path: 'rv:captureCoverage', maxCount: 1, in: ['rv:Complete', 'rv:Partial'] },
      ],
      or: [
        [
          { path: 'rv:collectionKind', hasValue: 'rv:StaticCollection' },
          { path: 'rv:capturedFrom', maxCount: 0 },
          { path: 'rv:captureCoverage', maxCount: 0 },
        ],
        [
          { path: 'rv:collectionKind', hasValue: 'rv:CapturedCollection' },
          { path: 'rv:capturedFrom', minCount: 1, maxCount: 1, class: 'rv:DynamicCollectionRevision' },
          { path: 'rv:captureCoverage', minCount: 1, maxCount: 1, in: ['rv:Complete', 'rv:Partial'] },
        ],
      ],
    },
    {
      iri: 'https://rezics.com/definition/collection-curation-v1/revision-shape',
      canonical: { types: ['rv:CollectionRevision'] },
      properties: [
        { path: 'rdf:type', minCount: 2, maxCount: 2,
          in: ['rv:CollectionRevision', 'rv:RevisionAnchor'] },
        { path: 'rv:component', minCount: 1, maxCount: 1, class: 'rv:Collection' },
        { path: 'rv:predecessor', maxCount: 1, class: 'rv:CollectionRevision' },
        oneIri('rv:operation'),
        { path: 'rv:collectionOperation', minCount: 1, maxCount: 1,
          in: ['rv:CollectionCreate', 'rv:CollectionCapture', 'rv:CollectionRename',
            'rv:CollectionDisclosureChange', 'rv:CollectionRetire', 'rv:CollectionRecover'] },
        oneIri('rv:manifest'),
        ...position,
      ],
    },
    {
      iri: 'https://rezics.com/definition/collection-curation-v1/definition-shape',
      canonical: { types: ['rv:DynamicCollection'] },
      properties: [
        { path: 'rdf:type', hasValue: 'rv:DynamicCollection', maxCount: 1 },
        oneIri('rv:curator'),
        { path: 'rv:disclosure', minCount: 1, maxCount: 1, in: ['rv:Public', 'rv:Private'] },
        { path: 'rv:collectionState', minCount: 1, maxCount: 1, in: ['rv:Active', 'rv:Retired'] },
        { path: 'rv:definitionHead', minCount: 1, maxCount: 1, class: 'rv:DynamicCollectionRevision' },
        { path: 'schema:name', minCount: 1, datatype: 'rdf:langString', maxLength: 300,
          uniqueLang: true },
      ],
    },
    {
      iri: 'https://rezics.com/definition/collection-curation-v1/definition-revision-shape',
      canonical: { types: ['rv:DynamicCollectionRevision'] },
      properties: [
        { path: 'rdf:type', minCount: 2, maxCount: 2,
          in: ['rv:DynamicCollectionRevision', 'rv:RevisionAnchor'] },
        { path: 'rv:component', minCount: 1, maxCount: 1, class: 'rv:DynamicCollection' },
        { path: 'rv:predecessor', maxCount: 1, class: 'rv:DynamicCollectionRevision' },
        oneIri('rv:operation'),
        oneIri('rv:queryProfile'),
        oneIri('rv:manifest'),
        { path: 'rv:resultBudget', minCount: 1, maxCount: 1, datatype: 'xsd:integer',
          minInclusive: 1, maxInclusive: 10000 },
        ...position,
      ],
    },
  ],
} as const satisfies ProfileDefinition;
