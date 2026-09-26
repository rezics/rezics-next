import type { ProfileDefinition } from '../compiler/ir.ts';

const definition = '<https://rezics.com/definition/zone-capability-v1>' as const;
const uuid = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const oneIri = (path: `rv:${string}`) => ({ path, minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' as const });

export const zoneCapabilityProfile = {
  id: 'zone-capability-v1',
  comments: [
    'A Zone is a Space capability for routes, navigation and presentation, retired independently of a Realm.',
    'Mounts are occurrences of the Zone navigation Structure; a mount copies no content and grants no control.',
    'Configuration revisions retain unknown advanced settings by digest so an API edit cannot drop them.',
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
      iri: 'https://rezics.com/definition/zone-capability-v1/zone-shape',
      canonical: { types: ['rv:Zone'] },
      properties: [
        { path: 'rdf:type', hasValue: 'rv:Zone', maxCount: 1 },
        { path: 'rv:space', minCount: 1, maxCount: 1, class: 'rv:Space' },
        { path: 'rv:zoneState', minCount: 1, maxCount: 1, in: ['rv:Active', 'rv:Retired'] },
        { path: 'rv:zoneHead', minCount: 1, maxCount: 1, class: 'rv:ZoneRevision' },
        // The owner receipt precedes the recoverable Structure creation receipt.
        { path: 'rv:navigation', maxCount: 1, class: 'rv:Structure' },
        { path: 'rv:disclosure', minCount: 1, maxCount: 1, in: ['rv:Public', 'rv:Private'] },
        { path: 'rv:defaultRealm', maxCount: 1, class: 'rv:Realm' },
        { path: 'rv:presentation', maxCount: 1, nodeKind: 'sh:IRI' },
      ],
    },
    {
      iri: 'https://rezics.com/definition/zone-capability-v1/mount-shape',
      canonical: { types: ['rv:ZoneMount'] },
      properties: [
        { path: 'rdf:type', hasValue: 'rv:ZoneMount', maxCount: 1 },
        { path: 'rv:zone', minCount: 1, maxCount: 1, class: 'rv:Zone' },
        { path: 'rv:routeSegment', minCount: 1, maxCount: 1, datatype: 'xsd:string',
          pattern: '^[a-z0-9]+(-[a-z0-9]+)*$', maxLength: 64 },
        { path: 'rv:disclosure', minCount: 1, maxCount: 1, in: ['rv:Public', 'rv:Private'] },
        { path: 'rv:presentation', maxCount: 1, nodeKind: 'sh:IRI' },
      ],
    },
    {
      iri: 'https://rezics.com/definition/zone-capability-v1/revision-shape',
      canonical: { types: ['rv:ZoneRevision'] },
      properties: [
        { path: 'rdf:type', minCount: 2, maxCount: 2, in: ['rv:ZoneRevision', 'rv:RevisionAnchor'] },
        { path: 'rv:component', minCount: 1, maxCount: 1, class: 'rv:Zone' },
        { path: 'rv:predecessor', maxCount: 1, class: 'rv:ZoneRevision' },
        oneIri('rv:operation'),
        { path: 'rv:zoneOperation', minCount: 1, maxCount: 1,
          in: ['rv:ZoneCreate', 'rv:ZoneConfigure', 'rv:ZoneRetire', 'rv:ZoneRecover'] },
        oneIri('rv:manifest'),
        { path: 'rv:advancedConfig', maxCount: 1, nodeKind: 'sh:IRI' },
        { path: 'rv:modelRevision', hasValue: definition, maxCount: 1 },
        { path: 'rv:shapeRevision', hasValue: definition, maxCount: 1 },
        { path: 'rv:datasetId', hasValue: '<urn:rezics:dataset:product>', maxCount: 1 },
        { path: 'rv:dataEpoch', minCount: 1, maxCount: 1, datatype: 'xsd:string', pattern: uuid },
        { path: 'rv:sequence', minCount: 1, maxCount: 1, datatype: 'xsd:integer', minInclusive: 1 },
      ],
    },
  ],
} as const satisfies ProfileDefinition;
