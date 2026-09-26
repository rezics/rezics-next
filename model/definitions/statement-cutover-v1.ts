import type { ProfileDefinition } from '../compiler/ir.ts';

const PROFILE = '<https://rezics.com/definition/statement-cutover-v1>';

/** One retained marker that freezes the v1 classification writer after exact conversion. */
export const statementCutoverProfile = {
  id: 'statement-cutover-v1',
  comments: ['The retained cutover anchor records the one-way Statement decision transition.'],
  prefixes: [
    ['sh', 'http://www.w3.org/ns/shacl#'],
    ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['xsd', 'http://www.w3.org/2001/XMLSchema#'],
    ['rv', 'https://rezics.com/vocab/'],
  ],
  layout: 'compact',
  shapes: [{
    iri: 'https://rezics.com/definition/statement-cutover-v1/cutover-shape',
    canonical: { types: ['rv:StatementCutover'] },
    properties: [
      { path: 'rdf:type', in: ['rv:StatementCutover', 'rv:RevisionAnchor'], minCount: 2, maxCount: 2 },
      { path: 'rv:component', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:recordedBy', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:operation', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:modelRevision', hasValue: PROFILE, maxCount: 1 },
      { path: 'rv:shapeRevision', hasValue: PROFILE, maxCount: 1 },
      { path: 'rv:manifest', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:dataEpoch', minCount: 1, maxCount: 1, datatype: 'xsd:string' },
      { path: 'rv:sequence', minCount: 1, maxCount: 1, datatype: 'xsd:integer', minInclusive: 1 },
    ],
  }],
} as const satisfies ProfileDefinition;
