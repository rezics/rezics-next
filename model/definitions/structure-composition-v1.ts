import type { ProfileDefinition, PropertyDefinition } from '../compiler/ir.ts';

const definition = '<https://rezics.com/definition/structure-composition-v1>' as const;
const uuid = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
// Order and segment keys are fractional base-36 digits ([0-9a-z]); byte order is sibling order.
const orderKey = '^[a-z0-9]+(-[a-z0-9]+)*$';
const oneIri = (path: `rv:${string}`) => ({ path, minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' as const });

export const STRUCTURE_ROLES = ['rv:GroupRole', 'rv:ChapterRole', 'rv:MemberRole', 'rv:MountRole',
  'rv:NavigationRole', 'rv:IngredientRole', 'rv:StepRole', 'rv:EquipmentRole'] as const;

const position: readonly PropertyDefinition[] = [
  { path: 'rv:modelRevision', hasValue: definition, maxCount: 1 },
  { path: 'rv:shapeRevision', hasValue: definition, maxCount: 1 },
  { path: 'rv:datasetId', hasValue: '<urn:rezics:dataset:product>', maxCount: 1 },
  { path: 'rv:dataEpoch', minCount: 1, maxCount: 1, datatype: 'xsd:string', pattern: uuid },
  { path: 'rv:sequence', minCount: 1, maxCount: 1, datatype: 'xsd:integer', minInclusive: 1 },
];

// Selection policy of one targeted use. Structural roles carry no target.
const selection: readonly (readonly PropertyDefinition[])[] = [
  [
    { path: 'rv:target', maxCount: 0 },
    { path: 'rv:selectionMode', maxCount: 0 },
    { path: 'rv:selectionRealm', maxCount: 0 },
    { path: 'rv:pinnedRevision', maxCount: 0 },
  ],
  [
    // Profile writers admit exact external catalog classes here; unlike a resource target,
    // a type IRI has no content variant or access grant to follow.
    oneIri('rv:target'),
    { path: 'rv:selectionMode', maxCount: 0 },
    { path: 'rv:selectionRealm', maxCount: 0 },
    { path: 'rv:pinnedRevision', maxCount: 0 },
  ],
  [
    oneIri('rv:target'),
    { path: 'rv:selectionMode', hasValue: 'rv:FollowContext' },
    { path: 'rv:selectionRealm', maxCount: 0 },
    { path: 'rv:pinnedRevision', maxCount: 0 },
  ],
  [
    oneIri('rv:target'),
    { path: 'rv:selectionMode', hasValue: 'rv:FixedRealm' },
    { path: 'rv:selectionRealm', minCount: 1, maxCount: 1, class: 'rv:Realm' },
    { path: 'rv:pinnedRevision', maxCount: 0 },
  ],
  [
    oneIri('rv:target'),
    { path: 'rv:selectionMode', hasValue: 'rv:FixedRevision' },
    { path: 'rv:selectionRealm', maxCount: 0 },
    oneIri('rv:pinnedRevision'),
  ],
];

export const structureCompositionProfile = {
  id: 'structure-composition-v1',
  comments: [
    'A Structure owns identified occurrences; an occurrence is one use, so a target may repeat.',
    'Current placements belong to one generation; the Structure selects exactly one generation.',
    'Every topology change advances rv:structureHead under the command head guard; revisions pin complete immutable manifests.',
    'Parent ownership, cycles, role admission and order-key uniqueness are guarded by the command.',
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
      iri: 'https://rezics.com/definition/structure-composition-v1/structure-shape',
      canonical: { types: ['rv:Structure'] },
      properties: [
        { path: 'rdf:type', hasValue: 'rv:Structure', maxCount: 1 },
        oneIri('rv:structureOf'),
        { path: 'rv:structureProfile', minCount: 1, maxCount: 1,
          in: ['rv:BookComposition', 'rv:CollectionMembership', 'rv:ZoneNavigation',
            'rv:WikiNavigation', 'rv:RecipeComposition'] },
        { path: 'rv:structureHead', minCount: 1, maxCount: 1, class: 'rv:StructureRevision' },
        { path: 'rv:selectedGeneration', minCount: 1, maxCount: 1, class: 'rv:StructureGeneration' },
      ],
    },
    {
      iri: 'https://rezics.com/definition/structure-composition-v1/generation-shape',
      canonical: { types: ['rv:StructureGeneration'] },
      properties: [
        { path: 'rdf:type', hasValue: 'rv:StructureGeneration', maxCount: 1 },
        { path: 'rv:structure', minCount: 1, maxCount: 1, class: 'rv:Structure' },
        { path: 'rv:generationState', minCount: 1, maxCount: 1,
          in: ['rv:Staging', 'rv:Active', 'rv:Retired', 'rv:Cancelled'] },
        oneIri('rv:stagedBy'),
        { path: 'rv:baseRevision', maxCount: 1, class: 'rv:StructureRevision' },
        { path: 'rv:placementCount', minCount: 1, maxCount: 1, datatype: 'xsd:integer',
          minInclusive: 0, maxInclusive: 1048576 },
      ],
    },
    {
      iri: 'https://rezics.com/definition/structure-composition-v1/segment-shape',
      canonical: { types: ['rv:OrderSegment'] },
      properties: [
        { path: 'rdf:type', hasValue: 'rv:OrderSegment', maxCount: 1 },
        { path: 'rv:generation', minCount: 1, maxCount: 1, class: 'rv:StructureGeneration' },
        oneIri('rv:parent'),
        { path: 'rv:segmentKey', minCount: 1, maxCount: 1, datatype: 'xsd:string',
          pattern: orderKey, maxLength: 32 },
        { path: 'rv:memberCount', minCount: 1, maxCount: 1, datatype: 'xsd:integer',
          minInclusive: 0, maxInclusive: 512 },
      ],
    },
    {
      iri: 'https://rezics.com/definition/structure-composition-v1/occurrence-shape',
      canonical: { types: ['rv:StructureOccurrence'] },
      properties: [
        { path: 'rdf:type', hasValue: 'rv:StructureOccurrence', maxCount: 1 },
        { path: 'rv:structure', minCount: 1, maxCount: 1, class: 'rv:Structure' },
        { path: 'rv:introducedBy', minCount: 1, maxCount: 1, class: 'rv:StructureRevision' },
      ],
    },
    {
      iri: 'https://rezics.com/definition/structure-composition-v1/placement-shape',
      canonical: { types: ['rv:OccurrencePlacement'] },
      properties: [
        { path: 'rdf:type', hasValue: 'rv:OccurrencePlacement', maxCount: 1 },
        { path: 'rv:occurrence', minCount: 1, maxCount: 1, class: 'rv:StructureOccurrence' },
        { path: 'rv:generation', minCount: 1, maxCount: 1, class: 'rv:StructureGeneration' },
        { path: 'rv:orderSegment', minCount: 1, maxCount: 1, class: 'rv:OrderSegment' },
        { path: 'rv:orderKey', minCount: 1, maxCount: 1, datatype: 'xsd:string',
          pattern: orderKey, maxLength: 32 },
        { path: 'rv:occurrenceRole', minCount: 1, maxCount: 1, in: STRUCTURE_ROLES },
        { path: 'rv:occurrenceLabel', datatype: 'rdf:langString', maxLength: 500, uniqueLang: true },
        { path: 'rv:qualifier', maxCount: 1, nodeKind: 'sh:IRI' },
        { path: 'rv:sourceKey', maxCount: 1, datatype: 'xsd:string', minLength: 1, maxLength: 200 },
        { path: 'rv:target', maxCount: 1, nodeKind: 'sh:IRI' },
        { path: 'rv:selectionMode', maxCount: 1,
          in: ['rv:FollowContext', 'rv:FixedRealm', 'rv:FixedRevision'] },
        { path: 'rv:selectionRealm', maxCount: 1, nodeKind: 'sh:IRI' },
        { path: 'rv:pinnedRevision', maxCount: 1, nodeKind: 'sh:IRI' },
      ],
      or: selection,
    },
    {
      iri: 'https://rezics.com/definition/structure-composition-v1/removed-placement-shape',
      canonical: { types: ['rv:RemovedPlacement'] },
      properties: [
        { path: 'rdf:type', hasValue: 'rv:RemovedPlacement', maxCount: 1 },
        { path: 'rv:occurrence', minCount: 1, maxCount: 1, class: 'rv:StructureOccurrence' },
        { path: 'rv:generation', minCount: 1, maxCount: 1, class: 'rv:StructureGeneration' },
        { path: 'rv:orderSegment', maxCount: 0 },
        { path: 'rv:orderKey', maxCount: 0 },
        { path: 'rv:occurrenceRole', minCount: 1, maxCount: 1, in: STRUCTURE_ROLES },
        oneIri('rv:lastParent'),
        { path: 'rv:removedBy', minCount: 1, maxCount: 1, class: 'rv:StructureRevision' },
        { path: 'rv:target', maxCount: 1, nodeKind: 'sh:IRI' },
        { path: 'rv:sourceKey', maxCount: 1, datatype: 'xsd:string', minLength: 1, maxLength: 200 },
      ],
    },
    {
      iri: 'https://rezics.com/definition/structure-composition-v1/revision-shape',
      canonical: { types: ['rv:StructureRevision'] },
      properties: [
        { path: 'rdf:type', minCount: 2, maxCount: 2, in: ['rv:StructureRevision', 'rv:RevisionAnchor'] },
        { path: 'rv:component', minCount: 1, maxCount: 1, class: 'rv:Structure' },
        { path: 'rv:predecessor', maxCount: 1, class: 'rv:StructureRevision' },
        oneIri('rv:operation'),
        { path: 'rv:structureOperation', minCount: 1, maxCount: 1,
          in: ['rv:StructureCreate', 'rv:OccurrenceInsert', 'rv:OccurrenceMove', 'rv:OccurrenceReorder',
            'rv:OccurrenceRemove', 'rv:OccurrenceUpdate', 'rv:OrderRebalance', 'rv:StructureReplace',
            'rv:StructureImport', 'rv:StructureRefresh', 'rv:StructureCapture', 'rv:StructureRestore',
            'rv:StructureMeasureChange'] },
        { path: 'rv:generation', minCount: 1, maxCount: 1, class: 'rv:StructureGeneration' },
        oneIri('rv:manifest'),
        { path: 'rv:placementCount', minCount: 1, maxCount: 1, datatype: 'xsd:integer',
          minInclusive: 0, maxInclusive: 1048576 },
        ...position,
      ],
      or: [
        [
          { path: 'rv:structureOperation', minCount: 1, maxCount: 1,
            in: ['rv:StructureImport', 'rv:StructureRefresh', 'rv:StructureCapture'] },
          oneIri('rv:importSource'),
          oneIri('rv:importSourceRevision'),
          { path: 'rv:mappingPolicy', minCount: 1, maxCount: 1,
            in: ['rv:SourceKeyCorrespondence', 'rv:ExplicitCorrespondence'] },
          { path: 'rv:restoredFrom', maxCount: 0 },
        ],
        [
          { path: 'rv:structureOperation', hasValue: 'rv:StructureRestore' },
          { path: 'rv:restoredFrom', minCount: 1, maxCount: 1, class: 'rv:StructureRevision' },
          { path: 'rv:importSource', maxCount: 0 },
          { path: 'rv:importSourceRevision', maxCount: 0 },
          { path: 'rv:mappingPolicy', maxCount: 0 },
        ],
        [
          { path: 'rv:structureOperation', minCount: 1, maxCount: 1,
            in: ['rv:StructureCreate', 'rv:OccurrenceInsert', 'rv:OccurrenceMove', 'rv:OccurrenceReorder',
              'rv:OccurrenceRemove', 'rv:OccurrenceUpdate', 'rv:OrderRebalance', 'rv:StructureReplace',
              'rv:StructureMeasureChange'] },
          { path: 'rv:restoredFrom', maxCount: 0 },
          { path: 'rv:importSource', maxCount: 0 },
          { path: 'rv:importSourceRevision', maxCount: 0 },
          { path: 'rv:mappingPolicy', maxCount: 0 },
        ],
      ],
    },
    {
      iri: 'https://rezics.com/definition/structure-composition-v1/seal-shape',
      canonical: { types: ['rv:StructureSeal'] },
      properties: [
        { path: 'rdf:type', hasValue: 'rv:StructureSeal', maxCount: 1 },
        { path: 'rv:structure', minCount: 1, maxCount: 1, class: 'rv:Structure' },
        { path: 'rv:structureRevision', minCount: 1, maxCount: 1, class: 'rv:StructureRevision' },
        oneIri('rv:manifest'),
        oneIri('rv:sealedBy'),
        { path: 'rv:sealCoverage', minCount: 1, maxCount: 1, in: ['rv:Complete', 'rv:Partial'] },
        { path: 'rv:unavailableCount', minCount: 1, maxCount: 1, datatype: 'xsd:integer',
          minInclusive: 0, maxInclusive: 1048576 },
        ...position,
      ],
      or: [
        [
          { path: 'rv:sealCoverage', hasValue: 'rv:Complete' },
          { path: 'rv:unavailableCount', hasValue: '0' },
        ],
        [
          { path: 'rv:sealCoverage', hasValue: 'rv:Partial' },
          { path: 'rv:unavailableCount', minCount: 1, maxCount: 1, datatype: 'xsd:integer',
            minInclusive: 1 },
        ],
      ],
    },
  ],
} as const satisfies ProfileDefinition;
