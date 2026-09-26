import type { ProfileDefinition } from '../compiler/ir.ts';

const PROFILE = '<https://rezics.com/definition/protection-revision-v1>';

export const protectionRevisionProfile = {
  id: 'protection-revision-v1', layout: 'compact',
  comments: [
    'Append-only modification protection of one native Work English title slot in its Global context.',
    'Protection is not an evidence-quality verdict. Sealed modes and inherited root scopes are not admitted.',
  ],
  prefixes: [['sh', 'http://www.w3.org/ns/shacl#'], ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['xsd', 'http://www.w3.org/2001/XMLSchema#'], ['schema', 'https://schema.org/'], ['rv', 'https://rezics.com/vocab/']],
  shapes: [
    { iri: 'https://rezics.com/definition/protection-revision-v1/target-shape', properties: [
      { path: 'rdf:type', hasValue: 'schema:CreativeWork' },
      { path: 'rv:head', minCount: 1, maxCount: 1, class: 'rv:RevisionAnchor' },
      // Every pre-protection Work writer already fails closed on this predicate.
      { path: 'rv:protectionHead', minCount: 1, maxCount: 1, class: 'rv:ProtectionRevision' },
    ] },
    { iri: 'https://rezics.com/definition/protection-revision-v1/protection-shape', properties: [
      { path: 'rdf:type', in: ['rv:ProtectionRevision', 'rv:RevisionAnchor'], minCount: 2, maxCount: 2 },
      { path: 'rv:component', minCount: 1, maxCount: 1, class: 'schema:CreativeWork' },
      { path: 'rv:protectedSlot', hasValue: '"title:en"', maxCount: 1 },
      { path: 'rv:adoptionContext', hasValue: 'rv:GlobalNative', maxCount: 1 },
      { path: 'rv:protectionAction', minCount: 1, maxCount: 1, in: ['rv:Tighten', 'rv:Confirm', 'rv:Relax'] },
      { path: 'rv:protectionMode', minCount: 1, maxCount: 1, in: ['rv:Open', 'rv:ReviewRequired'] },
      { path: 'rv:protectionEpoch', minCount: 1, maxCount: 1, datatype: 'xsd:integer', minInclusive: 1 },
      { path: 'rv:predecessor', maxCount: 1, class: 'rv:ProtectionRevision' },
      { path: 'rv:ruleRevision', minCount: 1, maxCount: 1, in: ['<urn:rezics:protection-rule:independent-human-review-v1>'] },
      // Content head observed at activation: historical evidence, not a frozen value.
      { path: 'rv:workRevision', minCount: 1, maxCount: 1, class: 'rv:RevisionAnchor' },
      { path: 'rv:controlRevision', maxCount: 1, class: 'rv:EditorialControlRevision' },
      { path: 'rv:evidence', maxCount: 32, nodeKind: 'sh:IRI' },
      { path: 'rv:operation', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:protectionIntent', minCount: 1, maxCount: 1, datatype: 'xsd:string', maxLength: 16000 },
      { path: 'rv:manifest', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:modelRevision', hasValue: PROFILE, maxCount: 1 },
      { path: 'rv:shapeRevision', hasValue: PROFILE, maxCount: 1 },
      { path: 'rv:dataEpoch', minCount: 1, maxCount: 1, datatype: 'xsd:string' },
      { path: 'rv:sequence', minCount: 1, maxCount: 1, datatype: 'xsd:integer', minInclusive: 1 },
    ], or: [
      [{ path: 'rv:protectionAction', hasValue: 'rv:Tighten' }, { path: 'rv:protectionMode', hasValue: 'rv:ReviewRequired' }],
      // Confirm-and-protect records the exact accepted revision with a human control successor.
      [{ path: 'rv:protectionAction', hasValue: 'rv:Confirm' }, { path: 'rv:protectionMode', hasValue: 'rv:ReviewRequired' },
        { path: 'rv:controlRevision', minCount: 1, class: 'rv:EditorialControlRevision' }],
      [{ path: 'rv:protectionAction', hasValue: 'rv:Relax' }, { path: 'rv:protectionMode', hasValue: 'rv:Open' },
        { path: 'rv:predecessor', minCount: 1, class: 'rv:ProtectionRevision' }],
    ] },
  ],
} as const satisfies ProfileDefinition;
