import { t } from 'elysia';

const bytes = t.Object({ bytesBase64: t.String({ maxLength: 349528 }),
  sha256: t.String({ pattern: '^[0-9a-f]{64}$' }) }, { additionalProperties: false });
export const npmRequestV1Schema = t.Object({ profile: t.Literal('npm-lock-v3-topology-v1'),
  npmVersion: t.String({ minLength: 1, maxLength: 32 }),
  policy: t.String({ minLength: 1, maxLength: 64 }), manifest: bytes, lock: bytes }, { additionalProperties: false });
const nullable = t.Union([t.String(), t.Null()]);
const peerHost = t.Object({ name: t.String(), specifier: t.String(), host: t.String(), path: t.String() });
const instance = t.Object({ id: t.String(), path: t.String(), name: t.String(), version: t.String(),
  resolved: nullable, integrity: nullable, peerHosts: t.Array(peerHost, { maxItems: 256 }) });
const edge = t.Object({ from: t.String(), to: t.String(), kind: t.Union([t.Literal('dependency'), t.Literal('peer')]),
  name: t.String(), specifier: t.String() });
const issue = t.Object({ kind: t.Union(['missing-dependency', 'missing-peer', 'missing-parent',
  'missing-provenance', 'version-mismatch', 'peer-local', 'unreachable'].map(value => t.Literal(value))),
  path: t.String(), name: t.String(), specifier: nullable, foundPath: nullable });
const fields = { lockId: t.String(), provenance: t.Literal('caller-supplied'),
  lockfileVersion: t.Union([t.Integer(), t.Null()]),
  cost: t.Object({ inputBytes: t.Integer({ minimum: 0, maximum: 524288 }),
    nodeCount: t.Integer({ minimum: 0, maximum: 130 }), edgeCount: t.Integer({ minimum: 0, maximum: 257 }),
    ancestorLookups: t.Integer({ minimum: 0, maximum: 4097 }) }) };
const emptyGraph = { instances: t.Array(instance, { maxItems: 0 }), edges: t.Array(edge, { maxItems: 0 }) };
export const npmOutcomeSchema = t.Union([
  t.Object({ ...fields, status: t.Literal('validated'), lockfileVersion: t.Literal(3),
    instances: t.Array(instance, { maxItems: 129 }),
    edges: t.Array(edge, { maxItems: 256 }), issues: t.Array(issue, { maxItems: 0 }),
    unsupportedClauses: t.Array(t.String(), { maxItems: 0 }), budgetReason: t.Null() }),
  t.Object({ ...fields, ...emptyGraph, status: t.Union([t.Literal('incomplete-source-data'), t.Literal('invalid-topology')]),
    issues: t.Array(issue, { minItems: 1, maxItems: 643 }),
    unsupportedClauses: t.Array(t.String(), { maxItems: 0 }), budgetReason: t.Null() }),
  t.Object({ ...fields, ...emptyGraph, status: t.Literal('unsupported-semantics'),
    issues: t.Array(issue, { maxItems: 0 }), unsupportedClauses: t.Array(t.String(), { minItems: 1, maxItems: 1 }),
    budgetReason: t.Null() }),
  t.Object({ ...fields, ...emptyGraph, status: t.Literal('budget-exhausted'),
    issues: t.Array(issue, { maxItems: 0 }), unsupportedClauses: t.Array(t.String(), { maxItems: 0 }),
    budgetReason: t.String() }),
]);
export const npmResolutionV1Schema = t.Object({ profile: t.Literal('npm-lock-topology-receipt-v1'),
  resolution: t.String(), requestDigest: t.String(), request: npmRequestV1Schema,
  outcome: npmOutcomeSchema, createdAt: t.String() });
const target = t.Object({ os: t.String({ minLength: 1, maxLength: 32 }),
  cpu: t.String({ minLength: 1, maxLength: 32 }) }, { additionalProperties: false });
export const npmRequestV2Schema = t.Object({ ...npmRequestV1Schema.properties,
  profile: t.Literal('npm-lock-v3-topology-v2'), target }, { additionalProperties: false });
const selector = t.Union([t.Array(t.String(), { maxItems: 16 }), t.Null()]);
const platformInstance = t.Object({ ...instance.properties,
  peerHosts: t.Array(t.Object({ ...peerHost.properties, optional: t.Boolean() }), { maxItems: 256 }),
  optional: t.Boolean(), os: selector, cpu: selector });
const platformEdge = t.Object({ ...edge.properties, optional: t.Boolean() });
const platformIssue = t.Object({ ...issue.properties,
  kind: t.Union([...issue.properties.kind.anyOf, t.Literal('optional-flag-mismatch'), t.Literal('platform-incompatible')]) });
const omittedInstance = t.Object({ id: t.String(), path: t.String(), reason: t.Literal('platform'), causePath: t.String() });
const omittedEdge = t.Object({ ...platformEdge.properties, to: nullable, path: t.String(), foundPath: nullable,
  reason: t.Union([t.Literal('absent-optional'), t.Literal('platform')]) });
const platformFields = { ...fields, target,
  cost: t.Object({ ...fields.cost.properties, graphVisits: t.Integer({ minimum: 0, maximum: 65537 }) }) };
const emptyPlatform = { instances: t.Array(platformInstance, { maxItems: 0 }),
  edges: t.Array(platformEdge, { maxItems: 0 }), activeInstances: t.Array(t.String(), { maxItems: 0 }),
  activeEdges: t.Array(platformEdge, { maxItems: 0 }), omittedInstances: t.Array(omittedInstance, { maxItems: 0 }),
  omittedEdges: t.Array(omittedEdge, { maxItems: 0 }) };
const npmPlatformOutcomeSchema = t.Union([
  t.Object({ ...platformFields, status: t.Literal('validated'), lockfileVersion: t.Literal(3),
    instances: t.Array(platformInstance, { maxItems: 129 }), edges: t.Array(platformEdge, { maxItems: 256 }),
    activeInstances: t.Array(t.String(), { maxItems: 129 }), activeEdges: t.Array(platformEdge, { maxItems: 256 }),
    omittedInstances: t.Array(omittedInstance, { maxItems: 128 }), omittedEdges: t.Array(omittedEdge, { maxItems: 256 }),
    issues: t.Array(platformIssue, { maxItems: 0 }), unsupportedClauses: t.Array(t.String(), { maxItems: 0 }), budgetReason: t.Null() }),
  t.Object({ ...platformFields, ...emptyPlatform,
    status: t.Union([t.Literal('incomplete-source-data'), t.Literal('invalid-topology')]),
    issues: t.Array(platformIssue, { minItems: 1, maxItems: 772 }),
    unsupportedClauses: t.Array(t.String(), { maxItems: 0 }), budgetReason: t.Null() }),
  t.Object({ ...platformFields, ...emptyPlatform, status: t.Literal('unsupported-semantics'),
    issues: t.Array(platformIssue, { maxItems: 0 }), unsupportedClauses: t.Array(t.String(), { minItems: 1, maxItems: 1 }),
    budgetReason: t.Null() }),
  t.Object({ ...platformFields, ...emptyPlatform, status: t.Literal('budget-exhausted'),
    issues: t.Array(platformIssue, { maxItems: 0 }), unsupportedClauses: t.Array(t.String(), { maxItems: 0 }),
    budgetReason: t.String() }),
]);
export const npmResolutionV2Schema = t.Object({ ...npmResolutionV1Schema.properties,
  profile: t.Literal('npm-lock-topology-receipt-v2'), request: npmRequestV2Schema, outcome: npmPlatformOutcomeSchema });
export const npmRequestV3Schema = t.Object({ ...npmRequestV1Schema.properties,
  profile: t.Literal('npm-lock-v3-topology-v3'),
  workspaces: t.Array(t.Object({ path: t.String({ minLength: 1, maxLength: 512 }), manifest: bytes },
    { additionalProperties: false }), { maxItems: 16 }) }, { additionalProperties: false });
const identityInstance = t.Object({ ...instance.properties,
  kind: t.Union(['root', 'registry', 'workspace', 'link'].map(value => t.Literal(value))), slotName: nullable,
  linkTarget: t.Union([t.Object({ id: t.String(), path: t.String() }), t.Null()]) });
const identityEdge = t.Object({ ...edge.properties,
  kind: t.Union([...edge.properties.kind.anyOf, t.Literal('workspace')]), requestedName: t.String() });
const identityIssue = t.Object({ ...issue.properties,
  kind: t.Union([...issue.properties.kind.anyOf, ...['missing-workspace-manifest', 'missing-workspace-target',
    'missing-link-source', 'link-target-mismatch'].map(value => t.Literal(value))]) });
const identityFields = { ...fields, cost: t.Object({ ...fields.cost.properties,
  inputBytes: t.Integer({ minimum: 0, maximum: 4718592 }), workspaceCount: t.Integer({ minimum: 0, maximum: 16 }),
  graphVisits: t.Integer({ minimum: 0, maximum: 65537 }) }) };
const emptyIdentity = { instances: t.Array(identityInstance, { maxItems: 0 }), edges: t.Array(identityEdge, { maxItems: 0 }) };
export const npmIdentityOutcomeSchema = t.Union([
  t.Object({ ...identityFields, status: t.Literal('validated'), lockfileVersion: t.Literal(3),
    instances: t.Array(identityInstance, { maxItems: 129 }), edges: t.Array(identityEdge, { maxItems: 256 }),
    issues: t.Array(identityIssue, { maxItems: 0 }), unsupportedClauses: t.Array(t.String(), { maxItems: 0 }), budgetReason: t.Null() }),
  t.Object({ ...identityFields, ...emptyIdentity, status: t.Union([t.Literal('incomplete-source-data'), t.Literal('invalid-topology')]),
    issues: t.Array(identityIssue, { minItems: 1, maxItems: 804 }),
    unsupportedClauses: t.Array(t.String(), { maxItems: 0 }), budgetReason: t.Null() }),
  t.Object({ ...identityFields, ...emptyIdentity, status: t.Literal('unsupported-semantics'),
    issues: t.Array(identityIssue, { maxItems: 0 }), unsupportedClauses: t.Array(t.String(), { minItems: 1, maxItems: 1 }), budgetReason: t.Null() }),
  t.Object({ ...identityFields, ...emptyIdentity, status: t.Literal('budget-exhausted'),
    issues: t.Array(identityIssue, { maxItems: 0 }), unsupportedClauses: t.Array(t.String(), { maxItems: 0 }), budgetReason: t.String() }),
]);
export const npmResolutionV3Schema = t.Object({ ...npmResolutionV1Schema.properties,
  profile: t.Literal('npm-lock-topology-receipt-v3'), request: npmRequestV3Schema, outcome: npmIdentityOutcomeSchema });
export const npmRequestV4Schema = t.Object({ ...npmRequestV3Schema.properties,
  profile: t.Literal('npm-lock-v3-topology-v4'), target }, { additionalProperties: false });
const compositionInstance = t.Object({ ...identityInstance.properties,
  peerHosts: platformInstance.properties.peerHosts, optional: t.Boolean(), os: selector, cpu: selector });
const compositionEdge = t.Object({ ...identityEdge.properties, optional: t.Boolean() });
const compositionIssue = t.Object({ ...identityIssue.properties,
  kind: t.Union([...identityIssue.properties.kind.anyOf, t.Literal('optional-flag-mismatch'), t.Literal('platform-incompatible')]) });
const compositionOmittedEdge = t.Object({ ...compositionEdge.properties, to: nullable,
  path: t.String(), foundPath: nullable, reason: t.Union([t.Literal('absent-optional'), t.Literal('platform')]), causePath: nullable });
const compositionFields = { ...identityFields, target };
const emptyComposition = { instances: t.Array(compositionInstance, { maxItems: 0 }),
  edges: t.Array(compositionEdge, { maxItems: 0 }), activeInstances: t.Array(t.String(), { maxItems: 0 }),
  activeEdges: t.Array(compositionEdge, { maxItems: 0 }), omittedInstances: t.Array(omittedInstance, { maxItems: 0 }),
  omittedEdges: t.Array(compositionOmittedEdge, { maxItems: 0 }) };
export const npmCompositionOutcomeSchema = t.Union([
  t.Object({ ...compositionFields, status: t.Literal('validated'), lockfileVersion: t.Literal(3),
    instances: t.Array(compositionInstance, { maxItems: 129 }), edges: t.Array(compositionEdge, { maxItems: 256 }),
    activeInstances: t.Array(t.String(), { maxItems: 129 }), activeEdges: t.Array(compositionEdge, { maxItems: 256 }),
    omittedInstances: t.Array(omittedInstance, { maxItems: 128 }), omittedEdges: t.Array(compositionOmittedEdge, { maxItems: 256 }),
    issues: t.Array(compositionIssue, { maxItems: 0 }), unsupportedClauses: t.Array(t.String(), { maxItems: 0 }), budgetReason: t.Null() }),
  t.Object({ ...compositionFields, ...emptyComposition,
    status: t.Union([t.Literal('incomplete-source-data'), t.Literal('invalid-topology')]),
    issues: t.Array(compositionIssue, { minItems: 1, maxItems: 1062 }),
    unsupportedClauses: t.Array(t.String(), { maxItems: 0 }), budgetReason: t.Null() }),
  t.Object({ ...compositionFields, ...emptyComposition, status: t.Literal('unsupported-semantics'),
    issues: t.Array(compositionIssue, { maxItems: 0 }), unsupportedClauses: t.Array(t.String(), { minItems: 1, maxItems: 1 }), budgetReason: t.Null() }),
  t.Object({ ...compositionFields, ...emptyComposition, status: t.Literal('budget-exhausted'),
    issues: t.Array(compositionIssue, { maxItems: 0 }), unsupportedClauses: t.Array(t.String(), { maxItems: 0 }), budgetReason: t.String() }),
]);
export const npmResolutionV4Schema = t.Object({ ...npmResolutionV1Schema.properties,
  profile: t.Literal('npm-lock-topology-receipt-v4'), request: npmRequestV4Schema, outcome: npmCompositionOutcomeSchema });
const engineTarget = t.Object({ nodeVersion: t.String({ minLength: 1, maxLength: 32 }),
  npmVersion: t.String({ minLength: 1, maxLength: 32 }) }, { additionalProperties: false });
export const npmRequestV5Schema = t.Object({ ...npmRequestV4Schema.properties,
  profile: t.Literal('npm-lock-v3-topology-v5'), engineTarget }, { additionalProperties: false });
const policyFields = { ...compositionFields, engineTarget,
  overrideSelections: t.Array(t.Object({ fromPath: t.String(), toPath: nullable, name: t.String(),
    declaredSpecifier: t.String(), effectiveSpecifier: t.String() }), { maxItems: 256 }),
  engineChecks: t.Array(t.Object({ path: t.String(), node: nullable, npm: nullable,
    compatible: t.Boolean() }), { maxItems: 129 }) };
const policyIssue = t.Object({ ...compositionIssue.properties,
  kind: t.Union([...compositionIssue.properties.kind.anyOf, t.Literal('engine-incompatible')]) });
export const npmPolicyOutcomeSchema = t.Union([
  t.Object({ ...npmCompositionOutcomeSchema.anyOf[0]!.properties, ...policyFields,
    issues: t.Array(policyIssue, { maxItems: 0 }) }),
  t.Object({ ...npmCompositionOutcomeSchema.anyOf[1]!.properties, ...policyFields,
    issues: t.Array(policyIssue, { minItems: 1, maxItems: 1062 }) }),
  t.Object({ ...npmCompositionOutcomeSchema.anyOf[2]!.properties, ...policyFields,
    issues: t.Array(policyIssue, { maxItems: 0 }) }),
  t.Object({ ...npmCompositionOutcomeSchema.anyOf[3]!.properties, ...policyFields,
    issues: t.Array(policyIssue, { maxItems: 0 }) }),
]);
export const npmResolutionV5Schema = t.Object({ ...npmResolutionV1Schema.properties,
  profile: t.Literal('npm-lock-topology-receipt-v5'), request: npmRequestV5Schema, outcome: npmPolicyOutcomeSchema });
export const npmRequestSchema = t.Union([npmRequestV1Schema, npmRequestV2Schema, npmRequestV3Schema,
  npmRequestV4Schema, npmRequestV5Schema]);
export const npmResolutionSchema = t.Union([npmResolutionV1Schema, npmResolutionV2Schema, npmResolutionV3Schema,
  npmResolutionV4Schema, npmResolutionV5Schema]);
export const npmResolutionWriteSchema = t.Object({ resolution: npmResolutionSchema, replayed: t.Boolean() });
