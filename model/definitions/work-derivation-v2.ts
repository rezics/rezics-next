import type { ProfileDefinition } from '../compiler/ir.ts';

const profile = '<https://rezics.com/definition/work-derivation-v2>' as const;

/** Open kind vocabulary: SHACL checks the exact DefinitionRef, never a kind enumeration.
 * https://www.w3.org/TR/shacl/#ClassConstraintComponent */
export const workDerivationV2Profile = {
  id: 'work-derivation-v2',
  comments: ['An evidenced Work derivation pins a lexicon relation definition revision.',
    'Unresolved source versions remain representable; neither direction transfers facts or authority.'],
  prefixes: [['sh', 'http://www.w3.org/ns/shacl#'], ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['xsd', 'http://www.w3.org/2001/XMLSchema#'], ['schema', 'https://schema.org/'], ['rv', 'https://rezics.com/vocab/']],
  layout: 'compact',
  shapes: [{
    iri: 'https://rezics.com/definition/work-derivation-v2/derivation-shape',
    canonical: { types: ['rv:LexiconWorkDerivation'] },
    properties: [
      { path: 'rdf:type', hasValue: 'rv:LexiconWorkDerivation', minCount: 1, maxCount: 1 },
      { path: 'rv:targetWork', minCount: 1, maxCount: 1, class: 'schema:CreativeWork' },
      { path: 'rv:targetMainVersion', minCount: 1, maxCount: 1, class: 'rv:MainVersion' },
      { path: 'rv:targetMainRevision', minCount: 1, maxCount: 1, class: 'rv:RevisionAnchor' },
      { path: 'rv:sourceWork', minCount: 1, maxCount: 1, class: 'schema:CreativeWork' },
      { path: 'rv:sourceMainVersion', maxCount: 1, class: 'rv:MainVersion' },
      { path: 'rv:sourceMainRevision', maxCount: 1, class: 'rv:RevisionAnchor' },
      { path: 'rv:sourceVersionStatus', minCount: 1, maxCount: 1, in: ['rv:Exact', 'rv:Unresolved'] },
      { path: 'rv:derivationKind', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI', class: 'rv:DefinitionRevision' },
      { path: 'rv:evidence', minCount: 1, maxCount: 1, datatype: 'xsd:string', pattern: '^https://[^\\s<>"{}|\\^`]{1,2040}$' },
      { path: 'rv:linkedBy', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:corrects', maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:modelRevision', hasValue: profile, maxCount: 1 },
      { path: 'rv:shapeRevision', hasValue: profile, maxCount: 1 },
      { path: 'rv:datasetId', hasValue: '<urn:rezics:dataset:product>', maxCount: 1 },
      { path: 'rv:dataEpoch', minCount: 1, maxCount: 1, datatype: 'xsd:string' },
      { path: 'rv:sequence', minCount: 1, maxCount: 1, datatype: 'xsd:integer', minInclusive: 1 },
    ],
    or: [
      [{ path: 'rv:sourceVersionStatus', hasValue: 'rv:Exact' },
        { path: 'rv:sourceMainVersion', minCount: 1, class: 'rv:MainVersion' }, { path: 'rv:sourceMainRevision', minCount: 1, class: 'rv:RevisionAnchor' }],
      [{ path: 'rv:sourceVersionStatus', hasValue: 'rv:Unresolved' }, { path: 'rv:sourceMainRevision', maxCount: 0, nodeKind: 'sh:IRI' }],
    ],
  }],
  binding: {
    required: ['derivation', 'target-work', 'target-main', 'target-revision', 'source-work',
      'kind', 'evidence', 'actor', 'receipt', 'scope', 'epoch'],
    optional: ['source-main', 'source-revision'], roles: ['derivation'], demandedBy: ['rv:LexiconWorkDerivation'],
  },
} as const satisfies ProfileDefinition;
