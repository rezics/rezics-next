import type { ProfileDefinition } from '../compiler/ir.ts';

/** Publication identity and custody are independent of every Book placement. */
export const postProfile = {
  id: 'post-v1',
  comments: ['A Post owns Content and discussion; occurrences own placement and progress.'],
  prefixes: [
    ['sh', 'http://www.w3.org/ns/shacl#'],
    ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['rdfs', 'http://www.w3.org/2000/01/rdf-schema#'],
    ['schema', 'https://schema.org/'],
    ['rv', 'https://rezics.com/vocab/'],
  ],
  layout: 'compact',
  shapes: [{
    iri: 'https://rezics.com/definition/post-v1/post-shape',
    canonical: { types: ['rv:Post'] },
    properties: [
      { path: 'rdf:type', hasValue: 'rv:Post', maxCount: 1 },
      { path: 'rdfs:label', minCount: 1, uniqueLang: true, datatype: 'rdf:langString',
        minLength: 1, maxLength: 200 },
      { path: 'rv:publisher', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:head', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:protectionHead', maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:mainVersion', maxCount: 0 },
      { path: 'schema:isPartOf', maxCount: 0 },
    ],
  }],
  binding: { required: ['post', 'publisher', 'revision'], roles: ['post'], demandedBy: ['rv:Post'] },
} as const satisfies ProfileDefinition;
