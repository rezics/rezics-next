import type { ProfileDefinition } from '../compiler/ir.ts';

const profile = 'https://rezics.com/definition/work-metadata-details-v2';

/** Edition languages become a list. v1 components stay valid under work-metadata-details-v1. */
export const workMetadataDetailsV2Profile = {
  id: 'work-metadata-details-v2', layout: 'compact',
  comments: ['Edition revisions record a list of content languages, a translation and its original language,',
    'and the language of printed title or track-list text apart from content language.',
    'Empty content languages mean not recorded. The command rejects mul and a bare und list.'],
  prefixes: [['sh', 'http://www.w3.org/ns/shacl#'], ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['xsd', 'http://www.w3.org/2001/XMLSchema#'], ['schema', 'https://schema.org/'], ['rv', 'https://rezics.com/vocab/']],
  shapes: [
    { iri: `${profile}/component-shape`, canonical: { types: ['rv:EditionRecord'] }, properties: [
      { path: 'rdf:type', hasValue: 'rv:EditionRecord' },
      { path: 'rv:work', minCount: 1, maxCount: 1, class: 'schema:CreativeWork' },
      { path: 'rv:metadataKind', minCount: 1, maxCount: 1, hasValue: '"edition"' },
      { path: 'rv:metadataHead', minCount: 1, maxCount: 1, class: 'rv:WorkMetadataDetailsV2Revision' },
      { path: 'rv:editionState', minCount: 1, maxCount: 1, in: ['rv:Active', 'rv:Withdrawn'] },
      { path: 'rv:editionLanguage', maxCount: 1, datatype: 'xsd:string' },
      { path: 'rv:contentLanguages', maxCount: 1, datatype: 'xsd:string', maxLength: 400 },
      { path: 'rv:titleLanguage', maxCount: 1, datatype: 'xsd:string' },
      { path: 'rv:tracklistLanguage', maxCount: 1, datatype: 'xsd:string' },
      { path: 'rv:originalLanguages', maxCount: 1, datatype: 'xsd:string', maxLength: 200 },
      { path: 'rv:isTranslation', maxCount: 1, in: ['"true"'] },
    ] },
    { iri: `${profile}/revision-shape`, canonical: { types: ['rv:WorkMetadataDetailsV2Revision'] }, properties: [
      { path: 'rdf:type', in: ['rv:WorkMetadataDetailsV2Revision', 'rv:RevisionAnchor'], minCount: 2, maxCount: 2 },
      { path: 'rv:component', minCount: 1, maxCount: 1, class: 'rv:EditionRecord' },
      { path: 'rv:metadataState', minCount: 1, maxCount: 1, datatype: 'xsd:string', maxLength: 65536 },
      { path: 'rv:predecessor', maxCount: 1, class: 'rv:WorkMetadataDetailsV2Revision' },
      { path: 'rv:manifest', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:modelRevision', hasValue: `<${profile}>`, maxCount: 1 },
      { path: 'rv:shapeRevision', hasValue: `<${profile}>`, maxCount: 1 },
      { path: 'rv:dataEpoch', minCount: 1, maxCount: 1, datatype: 'xsd:string' },
      { path: 'rv:sequence', minCount: 1, maxCount: 1, datatype: 'xsd:integer', minInclusive: 1 },
    ] },
  ],
} as const satisfies ProfileDefinition;
