import type { ProfileDefinition } from '../compiler/ir.ts';

/** Offline sanitized-copy tombstone: an exact IRI and retained journal epoch. */
export const erasureGraphProfile = {
  id: 'erasure-graph-v1',
  comments: [
    'An erased exact graph revision retains only non-sensitive identity and the relay erasure epoch.',
    'Native commands refuse later inserts naming this exact IRI.',
  ],
  prefixes: [
    ['sh', 'http://www.w3.org/ns/shacl#'],
    ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['xsd', 'http://www.w3.org/2001/XMLSchema#'],
    ['rv', 'https://rezics.com/vocab/'],
  ],
  layout: 'compact',
  shapes: [{
    iri: 'https://rezics.com/definition/erasure-graph-v1/tombstone-shape',
    properties: [
      { path: 'rdf:type', hasValue: 'rv:ErasedRevision', maxCount: 1 },
      { path: 'rv:erasureEpoch', minCount: 1, maxCount: 1,
        datatype: 'xsd:integer', minInclusive: 1 },
    ],
  }],
} as const satisfies ProfileDefinition;
