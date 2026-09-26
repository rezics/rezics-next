import type { ProfileDefinition } from '../compiler/ir.ts';

const profile = '<https://rezics.com/definition/theme-activation-v1>';
const native = '^https://rezics\\.com/id/[0-9a-f-]{36}$';

export const themeActivationProfile = {
  id: 'theme-activation-v1',
  comments: [
    'An executable custom-theme activation binds one dependency digest and a bounded capability set to an exact approval.',
    'Activation revisions are append-only; expiry or rollback never makes an older approval current again.',
  ],
  prefixes: [
    ['sh', 'http://www.w3.org/ns/shacl#'],
    ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['xsd', 'http://www.w3.org/2001/XMLSchema#'],
    ['rv', 'https://rezics.com/vocab/'],
  ],
  layout: 'compact',
  shapes: [{
    iri: 'https://rezics.com/definition/theme-activation-v1/theme-shape',
    canonical: { types: ['rv:CustomTheme'] },
    properties: [
      { path: 'rdf:type', hasValue: 'rv:CustomTheme' },
      { path: 'rv:themeHead', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
    ],
  }, {
    iri: 'https://rezics.com/definition/theme-activation-v1/activation-shape',
    properties: [
      { path: 'rdf:type', in: ['rv:ThemeActivation', 'rv:RevisionAnchor'], minCount: 2, maxCount: 2 },
      { path: 'rv:component', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI', pattern: native },
      { path: 'rv:predecessor', maxCount: 1, nodeKind: 'sh:IRI', pattern: native },
      { path: 'rv:themeOwner', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI', pattern: native },
      { path: 'rv:dependencyDigest', minCount: 1, maxCount: 1, datatype: 'xsd:string', pattern: '^[0-9a-f]{64}$' },
      { path: 'rv:capabilityDigest', minCount: 1, maxCount: 1, datatype: 'xsd:string', pattern: '^[0-9a-f]{64}$' },
      { path: 'rv:capabilities', minCount: 1, maxCount: 1, datatype: 'xsd:string', maxLength: 4096 },
      { path: 'rv:origin', minCount: 1, maxCount: 1, datatype: 'xsd:string',
        pattern: '^https://[^\\s/?#]{1,500}$', maxLength: 512 },
      { path: 'rv:runtime', hasValue: '"worker-isolated-v1"', maxCount: 1 },
      { path: 'rv:approvalId', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI', pattern: native },
      { path: 'rv:approvedBy', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI', pattern: native },
      { path: 'rv:approvedAt', minCount: 1, maxCount: 1, datatype: 'xsd:dateTime' },
      { path: 'rv:approvalExpiresAt', minCount: 1, maxCount: 1, datatype: 'xsd:dateTime' },
      { path: 'rv:approvalGeneration', minCount: 1, maxCount: 1, datatype: 'xsd:integer', minInclusive: 1 },
      { path: 'rv:operation', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:modelRevision', hasValue: profile, maxCount: 1 },
      { path: 'rv:shapeRevision', hasValue: profile, maxCount: 1 },
      { path: 'rv:datasetId', hasValue: '<urn:rezics:dataset:product>', maxCount: 1 },
      { path: 'rv:dataEpoch', minCount: 1, maxCount: 1, datatype: 'xsd:string', pattern: '^[0-9a-f-]{36}$' },
      { path: 'rv:sequence', minCount: 1, maxCount: 1, datatype: 'xsd:integer', minInclusive: 1 },
    ],
  }],
} as const satisfies ProfileDefinition;
