import type { ProfileDefinition } from '../compiler/ir.ts';

export const nativeAgentCreditProfile = {
  id: 'native-agent-credit-v1',
  comments: [
    'An explicit Work-maintainer attribution to a native Agent, not an external source author key.',
    'The Work-edit admission records the credit; contribution authorship does not imply Work authorship.',
    'Only current unerased credits to public Agents appear in public profile reads.',
  ],
  prefixes: [['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['sh', 'http://www.w3.org/ns/shacl#'], ['rv', 'https://rezics.com/vocab/'],
    ['schema', 'https://schema.org/'], ['xsd', 'http://www.w3.org/2001/XMLSchema#']],
  layout: 'compact',
  shapes: [{ iri: 'https://rezics.com/definition/native-agent-credit-v1/credit-shape',
    canonical: { types: ['rv:NativeAgentCredit'] }, properties: [
    { path: 'rdf:type', hasValue: 'rv:NativeAgentCredit' },
    { path: 'rv:work', minCount: 1, maxCount: 1, class: 'schema:CreativeWork' },
    { path: 'rv:agent', minCount: 1, maxCount: 1, class: 'rv:Agent' },
    { path: 'rv:creditRevision', minCount: 1, maxCount: 1, class: 'rv:NativeAgentCreditRevision' },
    { path: 'schema:roleName', minCount: 1, maxCount: 1,
      in: ['"author"', '"translator"', '"editor"'] },
    { path: 'rv:externalKey', maxCount: 0 },
  ] }, { iri: 'https://rezics.com/definition/native-agent-credit-v1/revision-shape',
    canonical: { types: ['rv:NativeAgentCreditRevision'] }, properties: [
    { path: 'rdf:type', hasValue: 'rv:NativeAgentCreditRevision' },
    { path: 'rv:component', minCount: 1, maxCount: 1, class: 'rv:NativeAgentCredit' },
    { path: 'rv:work', minCount: 1, maxCount: 1, class: 'schema:CreativeWork' },
    { path: 'rv:agent', minCount: 1, maxCount: 1, class: 'rv:Agent' },
    { path: 'rv:workRevision', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
    { path: 'schema:roleName', minCount: 1, maxCount: 1,
      in: ['"author"', '"translator"', '"editor"'] },
  ] }],
} as const satisfies ProfileDefinition;
