import type { ProfileDefinition } from '../compiler/ir.ts';

const profile = 'https://rezics.com/definition/release-v2';

/** A release says what it is. Kind and status use MusicBrainz's release status,
 * including virtual, which is never evidence that anything was published. */
export const releaseV2Profile = {
  id: 'release-v2', layout: 'compact',
  comments: ['One release is a formal edition, a web publication, a REZICS fixed release, or a virtual release.',
    'An unofficial release is its own record. Closed kinds are corrected with evidence, not extended.'],
  prefixes: [['sh', 'http://www.w3.org/ns/shacl#'], ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['xsd', 'http://www.w3.org/2001/XMLSchema#'], ['schema', 'https://schema.org/'], ['rv', 'https://rezics.com/vocab/']],
  shapes: [
    { iri: `${profile}/release-shape`, canonical: { types: ['rv:Release'], when: [{ path: 'rv:definitionProfile', value: `<${profile}>` }] }, properties: [
      { path: 'rdf:type', hasValue: 'rv:Release', maxCount: 1 },
      { path: 'rv:work', minCount: 1, maxCount: 64, class: 'schema:CreativeWork' },
      { path: 'rv:releaseKind', minCount: 1, maxCount: 1, in: ['"formal"', '"web"', '"fixed"', '"virtual"'] },
      { path: 'rv:releaseStatus', minCount: 1, maxCount: 1,
        in: ['"official"', '"unofficial"', '"virtual"', '"withdrawn"', '"cancelled"'] },
      { path: 'rv:releaseHead', minCount: 1, maxCount: 1, class: 'rv:ReleaseRevision' },
      { path: 'rv:definitionProfile', hasValue: `<${profile}>`, maxCount: 1 },
      { path: 'rv:coverageRealization', minCount: 1, maxCount: 64, class: 'rv:Realization' },
      { path: 'rv:coverageRevision', minCount: 1, maxCount: 64, class: 'rv:RealizationRevision' },
      { path: 'rv:contentLanguage', minCount: 1, maxCount: 64, datatype: 'xsd:string' },
      { path: 'rv:platform', maxCount: 1, datatype: 'xsd:string', maxLength: 120 },
      { path: 'rv:territory', maxCount: 1, datatype: 'xsd:string', pattern: '^(?:[A-Z]{2}|[0-9]{3})$' },
      { path: 'rv:completeness', minCount: 1, maxCount: 4, in: ['"complete"', '"partial"', '"trial"', '"unknown"'] },
      { path: 'rv:isbn13', maxCount: 1, datatype: 'xsd:string', pattern: '^97[89][0-9]{10}$' },
      { path: 'rv:identifier', maxCount: 16, datatype: 'xsd:string', maxLength: 500 },
      { path: 'rv:contentLanguages', maxCount: 1, datatype: 'xsd:string', maxLength: 2304 },
      { path: 'rv:titleLanguage', maxCount: 1, datatype: 'xsd:string' },
      { path: 'rv:tracklistLanguage', maxCount: 1, datatype: 'xsd:string' },
      { path: 'rv:originalLanguages', maxCount: 1, datatype: 'xsd:string', maxLength: 200 },
      { path: 'rv:isTranslation', maxCount: 1, in: ['"true"'] },
      { path: 'rv:originalUrl', maxCount: 1, datatype: 'xsd:string', maxLength: 512 },
      { path: 'rv:fixedRelease', maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:coverageScope', maxCount: 1, datatype: 'xsd:string', maxLength: 120 },
      { path: 'rv:coverageComplete', maxCount: 1, in: ['"true"', '"false"'] },
    ] },
    { iri: `${profile}/revision-shape`, canonical: { types: ['rv:ReleaseRevision'], when: [{ path: 'rv:modelRevision', value: `<${profile}>` }] }, properties: [
      { path: 'rdf:type', in: ['rv:ReleaseRevision', 'rv:RevisionAnchor'], minCount: 2, maxCount: 2 },
      { path: 'rv:component', minCount: 1, maxCount: 1, class: 'rv:Release' },
      { path: 'rv:releaseState', minCount: 1, maxCount: 1, datatype: 'xsd:string', maxLength: 49152 },
      { path: 'rv:predecessor', maxCount: 1, class: 'rv:ReleaseRevision' },
      { path: 'rv:manifest', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:correctionEvidence', maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:modelRevision', hasValue: `<${profile}>`, maxCount: 1 },
      { path: 'rv:shapeRevision', hasValue: `<${profile}>`, maxCount: 1 },
      { path: 'rv:dataEpoch', minCount: 1, maxCount: 1, datatype: 'xsd:string' },
      { path: 'rv:sequence', minCount: 1, maxCount: 1, datatype: 'xsd:integer', minInclusive: 1 },
    ] },
  ],
} as const satisfies ProfileDefinition;
