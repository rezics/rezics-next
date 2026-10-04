import type { ProfileDefinition } from '../compiler/ir.ts';

const profile = '<https://rezics.com/definition/projection-v1>';

export const projectionProfile = {
  id: 'projection-v1',
  comments: [
    'One Resource naming a subject within a frame: the one projectionOf Resource seen in one to eight frame coordinates.',
    'Its identity is unique per subject and frame set; the owner never edits a projection, so its single revision is',
    'the immutable record of what it names. Facts about the subject within the frame stay Statements about the subject.',
  ],
  prefixes: [['sh', 'http://www.w3.org/ns/shacl#'], ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['xsd', 'http://www.w3.org/2001/XMLSchema#'], ['owl', 'http://www.w3.org/2002/07/owl#'],
    ['rv', 'https://rezics.com/vocab/']],
  layout: 'compact',
  shapes: [
    { iri: 'https://rezics.com/definition/projection-v1/projection-shape',
      canonical: { types: ['rv:Projection'] }, closed: true, properties: [
      { path: 'rdf:type', hasValue: 'rv:Projection' },
      { path: 'rv:projectionOf', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:frame', minCount: 1, maxCount: 8, nodeKind: 'sh:IRI' },
      { path: 'rv:projectionHead', minCount: 1, maxCount: 1, class: 'rv:ProjectionRevision' },
      { path: 'owl:sameAs', maxCount: 0 },
    ] },
    { iri: 'https://rezics.com/definition/projection-v1/revision-shape',
      canonical: { types: ['rv:ProjectionRevision'] }, closed: true, properties: [
      { path: 'rdf:type', in: ['rv:ProjectionRevision', 'rv:RevisionAnchor'], minCount: 2, maxCount: 2 },
      { path: 'rv:component', minCount: 1, maxCount: 1, class: 'rv:Projection' },
      { path: 'rv:projectionOf', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:frame', minCount: 1, maxCount: 8, nodeKind: 'sh:IRI' },
      { path: 'rv:operation', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:modelRevision', hasValue: profile, maxCount: 1 },
      { path: 'rv:shapeRevision', hasValue: profile, maxCount: 1 },
      { path: 'rv:datasetId', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:dataEpoch', minCount: 1, maxCount: 1, datatype: 'xsd:string' },
      { path: 'rv:sequence', minCount: 1, maxCount: 1, datatype: 'xsd:integer', minInclusive: 1 },
    ] },
  ],
  binding: { required: ['projection', 'revision'], roles: ['projection', 'revision'],
    demandedBy: ['rv:Projection', 'rv:ProjectionRevision'] },
} as const satisfies ProfileDefinition;
