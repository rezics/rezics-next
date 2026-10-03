import type { ProfileDefinition } from '../compiler/ir.ts';

const definition = '<https://rezics.com/definition/agent-profile-address-v1>' as const;
const languageTag = '^[a-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$';
const localized = [
  {
    path: 'rv:originalNameLanguage',
    minCount: 1,
    maxCount: 1,
    datatype: 'xsd:string',
    pattern: languageTag,
    maxLength: 35,
  },
  {
    path: 'rv:localizedName',
    minCount: 1,
    maxCount: 20,
    datatype: 'rdf:langString',
    uniqueLang: true,
    maxLength: 200,
  },
] as const;
const current = [
  { path: 'rdf:type', hasValue: 'rv:Agent' },
  {
    path: 'rv:agentKind',
    minCount: 1,
    maxCount: 1,
    in: ['rv:PersonAgent', 'rv:OrganizationAgent', 'rv:ServiceAgent'],
  },
  { path: 'rdfs:label', minCount: 1, maxCount: 1, datatype: 'xsd:string', maxLength: 200 },
  { path: 'rv:profileStateFormat', hasValue: 'rv:AddressedAgentProfileV1', maxCount: 1 },
  { path: 'rv:profileHandle', maxCount: 0 },
  { path: 'rv:profileDisclosure', minCount: 1, maxCount: 1, in: ['rv:Public', 'rv:Private'] },
  {
    path: 'rv:profileAvatarSelection',
    maxCount: 1,
    datatype: 'xsd:string',
    pattern: '^[0-9a-f-]{36}$',
  },
  { path: 'rv:profileBio', maxCount: 1, datatype: 'rdf:langString' },
] as const;
const revision = [
  {
    path: 'rdf:type',
    minCount: 2,
    maxCount: 2,
    in: ['rv:AgentPublicProfileRevision', 'rv:RevisionAnchor'],
  },
  { path: 'rv:component', minCount: 1, maxCount: 1, class: 'rv:Agent' },
  { path: 'rv:predecessor', minCount: 1, maxCount: 1, class: 'rv:RevisionAnchor' },
  { path: 'rv:operation', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
  { path: 'rv:profileHandle', maxCount: 0 },
  { path: 'rv:modelRevision', hasValue: definition, maxCount: 1 },
  { path: 'rv:shapeRevision', hasValue: definition, maxCount: 1 },
  { path: 'rv:datasetId', hasValue: '<urn:rezics:dataset:product>', maxCount: 1 },
  { path: 'rv:dataEpoch', minCount: 1, maxCount: 1, datatype: 'xsd:string' },
  { path: 'rv:sequence', minCount: 1, maxCount: 1, datatype: 'xsd:integer', minInclusive: 1 },
] as const;

/** Graph profiles contain display names. Chosen handles belong solely to the
 * address registry; neither provisioning nor edits allocate a graph handle. */
export const agentAddressProfile = {
  id: 'agent-profile-address-v1',
  comments: [
    'Agent names are optional addresses owned by the name registry.',
    'Public graph state never contains an allocated handle.',
    'Earlier profile revisions retain their accepted shapes and immutable bytes.',
  ],
  prefixes: [
    ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['rdfs', 'http://www.w3.org/2000/01/rdf-schema#'],
    ['sh', 'http://www.w3.org/ns/shacl#'],
    ['rv', 'https://rezics.com/vocab/'],
    ['xsd', 'http://www.w3.org/2001/XMLSchema#'],
  ],
  layout: 'compact',
  shapes: [
    {
      iri: 'https://rezics.com/definition/agent-profile-address-v1/profile-shape',
      canonical: {
        types: ['rv:Agent'],
        when: [{ path: 'rv:profileNameFormat', value: 'rv:PlainNameAddressV1' }],
      },
      properties: [
        ...current,
        {
          path: 'rv:profileNameFormat',
          minCount: 1,
          maxCount: 1,
          in: ['rv:PlainNameAddressV1', 'rv:LocalizedNameAddressV1'],
        },
        {
          path: 'rv:originalNameLanguage',
          maxCount: 1,
          datatype: 'xsd:string',
          pattern: languageTag,
          maxLength: 35,
        },
        {
          path: 'rv:localizedName',
          maxCount: 20,
          datatype: 'rdf:langString',
          uniqueLang: true,
          maxLength: 200,
        },
      ],
    },
    {
      iri: 'https://rezics.com/definition/agent-profile-address-v1/localized-profile-shape',
      canonical: {
        types: ['rv:Agent'],
        when: [{ path: 'rv:profileNameFormat', value: 'rv:LocalizedNameAddressV1' }],
      },
      properties: [
        ...current,
        { path: 'rv:profileNameFormat', hasValue: 'rv:LocalizedNameAddressV1', maxCount: 1 },
        ...localized,
      ],
    },
    {
      iri: 'https://rezics.com/definition/agent-profile-address-v1/revision-shape',
      canonical: {
        types: ['rv:AgentPublicProfileRevision'],
        when: [{ path: 'rv:modelRevision', value: definition }],
      },
      properties: revision,
    },
    {
      iri: 'https://rezics.com/definition/agent-profile-address-v1/localized-revision-shape',
      canonical: {
        types: ['rv:AgentPublicProfileRevision'],
        when: [
          { path: 'rv:modelRevision', value: definition },
          { path: 'rv:profileNameFormat', value: 'rv:LocalizedNameAddressV1' },
        ],
      },
      properties: [
        ...revision,
        { path: 'rv:profileNameFormat', hasValue: 'rv:LocalizedNameAddressV1', maxCount: 1 },
        ...localized,
      ],
    },
  ],
} as const satisfies ProfileDefinition;
