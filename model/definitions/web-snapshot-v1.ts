import type { ProfileDefinition } from '../compiler/ir.ts';

const profile = 'https://rezics.com/definition/web-snapshot-v1';

/** One Memento of a web publication: exact bytes, fetch time, and coverage. Closed once recorded. */
export const webSnapshotProfile = {
  id: 'web-snapshot-v1', layout: 'compact',
  comments: ['A snapshot is a source observation of a content location.',
    'Its bytes live in the object store. A later fetch is a new snapshot, not an edit.'],
  prefixes: [['sh', 'http://www.w3.org/ns/shacl#'], ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['xsd', 'http://www.w3.org/2001/XMLSchema#'], ['rv', 'https://rezics.com/vocab/']],
  shapes: [
    { iri: `${profile}/snapshot-shape`, canonical: { types: ['rv:WebSnapshot'] }, properties: [
      { path: 'rdf:type', hasValue: 'rv:WebSnapshot', maxCount: 1 },
      { path: 'rv:publication', minCount: 1, maxCount: 1, class: 'rv:Release' },
      { path: 'rv:work', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:fetchedAt', minCount: 1, maxCount: 1, datatype: 'xsd:dateTime' },
      { path: 'rv:byteDigest', minCount: 1, maxCount: 1, datatype: 'xsd:string', pattern: '^[0-9a-f]{64}$' },
      { path: 'rv:byteLength', minCount: 1, maxCount: 1, datatype: 'xsd:integer', minInclusive: 1 },
      { path: 'rv:coverageScope', minCount: 1, maxCount: 1, datatype: 'xsd:string', maxLength: 120 },
      { path: 'rv:coverageComplete', minCount: 1, maxCount: 1, in: ['"true"', '"false"'] },
      { path: 'rv:object', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:acquisition', minCount: 1, maxCount: 1, in: ['"fixture"', '"fetch"'] },
    ] },
  ],
} as const satisfies ProfileDefinition;
