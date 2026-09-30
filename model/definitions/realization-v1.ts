import type { ProfileDefinition } from '../compiler/ir.ts';

const profile = 'https://rezics.com/definition/realization-v1';
export const realizationProfile = {
  id: 'realization-v1', layout: 'compact',
  comments: ['A particular text of one Work; language and script never establish identity.',
    'Exact source revisions and unresolved continuity are distinct; unofficial stays unofficial.'],
  prefixes: [['sh', 'http://www.w3.org/ns/shacl#'], ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['xsd', 'http://www.w3.org/2001/XMLSchema#'], ['schema', 'https://schema.org/'], ['rv', 'https://rezics.com/vocab/']],
  shapes: [
    { iri: `${profile}/realization-shape`, canonical: { types: ['rv:Realization'] }, properties: [
      { path: 'rdf:type', hasValue: 'rv:Realization', maxCount: 1 },
      { path: 'rv:work', minCount: 1, maxCount: 1, class: 'schema:CreativeWork' },
      { path: 'rv:head', minCount: 1, maxCount: 1, class: 'rv:RealizationRevision' },
      { path: 'rv:contentLanguage', minCount: 1, maxCount: 1, datatype: 'xsd:string', maxLength: 35 },
      { path: 'rv:realizationKind', minCount: 1, maxCount: 1, in: ['"original"', '"translation"'] },
      { path: 'rv:realizationStatus', minCount: 1, maxCount: 1, in: ['"official"', '"unofficial"'] },
      { path: 'rv:verification', minCount: 1, maxCount: 1, in: ['"verified"', '"unverified"'] },
      { path: 'rv:translator', maxCount: 16, nodeKind: 'sh:IRI' },
      { path: 'rv:publisher', maxCount: 16, nodeKind: 'sh:IRI' },
    ] },
    { iri: `${profile}/revision-shape`, canonical: { types: ['rv:RealizationRevision'] }, properties: [
      { path: 'rdf:type', in: ['rv:RealizationRevision', 'rv:RevisionAnchor'], minCount: 2, maxCount: 2 },
      { path: 'rv:component', minCount: 1, maxCount: 1, class: 'rv:Realization' },
      { path: 'rv:realizationState', minCount: 1, maxCount: 1, datatype: 'xsd:string', maxLength: 8192 },
      { path: 'rv:sourceWork', minCount: 1, maxCount: 1, class: 'schema:CreativeWork' },
      { path: 'rv:sourceStatus', minCount: 1, maxCount: 1, in: ['"realization"', '"main-version"', '"unresolved"'] },
      { path: 'rv:sourceRevision', maxCount: 1, class: 'rv:RevisionAnchor' },
      { path: 'rv:evidence', maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:manifest', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:predecessor', maxCount: 1, class: 'rv:RealizationRevision' },
      { path: 'rv:modelRevision', hasValue: `<${profile}>`, maxCount: 1 },
      { path: 'rv:shapeRevision', hasValue: `<${profile}>`, maxCount: 1 },
      { path: 'rv:dataEpoch', minCount: 1, maxCount: 1, datatype: 'xsd:string' },
      { path: 'rv:sequence', minCount: 1, maxCount: 1, datatype: 'xsd:integer', minInclusive: 1 },
    ], or: [
      [{ path: 'rv:sourceStatus', hasValue: '"unresolved"' }, { path: 'rv:sourceRevision', maxCount: 0, nodeKind: 'sh:IRI' }],
      [{ path: 'rv:sourceStatus', in: ['"realization"', '"main-version"'] },
        { path: 'rv:sourceRevision', minCount: 1, nodeKind: 'sh:IRI' }],
    ] },
  ],
  binding: { required: ['realization', 'revision'], roles: ['realization', 'revision'],
    demandedBy: ['rv:RealizationRevision'] },
} as const satisfies ProfileDefinition;
