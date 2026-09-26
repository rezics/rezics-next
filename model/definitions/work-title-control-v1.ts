import type { ProfileDefinition } from '../compiler/ir.ts';

export const workTitleControlProfile = {
  id: 'work-title-control-v1', layout: 'compact',
  comments: ['One native Work English title control epoch. No generic protection or source rights claim.'],
  prefixes: [['sh', 'http://www.w3.org/ns/shacl#'], ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['xsd', 'http://www.w3.org/2001/XMLSchema#'], ['schema', 'https://schema.org/'], ['rv', 'https://rezics.com/vocab/']],
  shapes: [{ iri: 'https://rezics.com/definition/work-title-control-v1/control-shape', properties: [
    { path: 'rdf:type', in: ['rv:EditorialControlRevision', 'rv:RevisionAnchor'], minCount: 2, maxCount: 2 },
    { path: 'rv:component', minCount: 1, maxCount: 1, class: 'schema:CreativeWork' },
    { path: 'rv:controlField', hasValue: '"title:en"', maxCount: 1 },
    { path: 'rv:controlMode', in: ['rv:SourceManaged', 'rv:HumanControlled'], minCount: 1, maxCount: 1 },
    { path: 'rv:controlEpoch', minCount: 1, maxCount: 1, datatype: 'xsd:integer', minInclusive: 1 },
    { path: 'rv:workRevision', minCount: 1, maxCount: 1, class: 'rv:RevisionAnchor' },
    { path: 'rv:predecessor', maxCount: 1, class: 'rv:EditorialControlRevision' },
    { path: 'rv:operation', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
    { path: 'rv:controlIntent', minCount: 1, maxCount: 1, datatype: 'xsd:string', maxLength: 8000 },
    { path: 'rv:manifest', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
    { path: 'rv:modelRevision', hasValue: '<https://rezics.com/definition/work-title-control-v1>', maxCount: 1 },
    { path: 'rv:shapeRevision', hasValue: '<https://rezics.com/definition/work-title-control-v1>', maxCount: 1 },
    { path: 'rv:dataEpoch', minCount: 1, maxCount: 1, datatype: 'xsd:string' },
    { path: 'rv:sequence', minCount: 1, maxCount: 1, datatype: 'xsd:integer', minInclusive: 1 },
  ] }],
} as const satisfies ProfileDefinition;
