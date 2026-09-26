import { t } from 'elysia';

const bytes = t.Object({ bytesBase64: t.String({ maxLength: 349528 }),
  sha256: t.String({ pattern: '^[0-9a-f]{64}$' }) }, { additionalProperties: false });
export const npmRequestSchema = t.Object({ profile: t.Literal('npm-lock-v3-topology-v1'),
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
export const npmResolutionSchema = t.Object({ profile: t.Literal('npm-lock-topology-receipt-v1'),
  resolution: t.String(), requestDigest: t.String(), request: npmRequestSchema,
  outcome: npmOutcomeSchema, createdAt: t.String() });
export const npmResolutionWriteSchema = t.Object({ resolution: npmResolutionSchema, replayed: t.Boolean() });
