import type { ProfileDefinition } from '../compiler/ir.ts';

export const textContributionProfile = {
  id: 'text-contribution-v1',
  comments: [
    'Fixed first S2 draft profile. The trusted caller targets the proposed identity.',
    'Work existence, authority, immutable bytes and transactional guards remain',
    "command obligations; this shape checks the candidate's local structure.",
  ],
  prefixes: [
    ['sh', 'http://www.w3.org/ns/shacl#'],
    ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['xsd', 'http://www.w3.org/2001/XMLSchema#'],
    ['rv', 'https://rezics.com/vocab/'],
  ],
  layout: 'compact',
  shapes: [{
    iri: 'https://rezics.com/definition/text-contribution-v1/contribution-shape',
    properties: [
      { path: 'rdf:type', hasValue: 'rv:TextContribution' },
      { path: 'rv:work', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:author', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:language', minCount: 1, maxCount: 1, datatype: 'xsd:string', pattern: '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$', wrapAfter: 3 },
      { path: 'rv:draftHead', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
    ],
  }],
} as const satisfies ProfileDefinition;
