import { t } from 'elysia';
import { semanticParticipantSchema as participantSchema } from '../semantic/value-contract.ts';

const native = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });
const text = (maxLength: number) => t.String({ minLength: 1, maxLength, pattern: '^[^\\u0000-\\u001f\\u007f]+$' });
export const relationSourceIdentity = t.Object({ provider: text(64), namespace: text(64), key: text(200),
  alias: t.Nullable(text(200)), eid: t.Nullable(text(200)), note: t.Nullable(text(2000)) }, { additionalProperties: false });
export const relationAttributionSupport = t.Object({ basis: t.Union([
  t.Object({ kind: t.Literal('source-credit'), support: native }, { additionalProperties: false }),
  t.Object({ kind: t.Literal('native-credit'), credit: native, revision: native }, { additionalProperties: false }),
  t.Object({ kind: t.Literal('source-binding'), binding: native }, { additionalProperties: false }),
  t.Object({ kind: t.Literal('selected-publication'), decision: native }, { additionalProperties: false }),
]), fields: t.Array(t.Union((['creditedName', 'provider', 'namespace', 'key', 'alias', 'eid', 'note'] as const).map(value => t.Literal(value))),
  { minItems: 1, maxItems: 7, uniqueItems: true }),
evidence: t.Array(text(2048), { minItems: 1, maxItems: 16, uniqueItems: true }) }, { additionalProperties: false });
const creditedName = t.Object({ lexical: t.String({ minLength: 1, maxLength: 200 }), language: t.String({ minLength: 2, maxLength: 35 }) }, { additionalProperties: false });
export const attributedParticipation = t.Object({ role: t.String({ minLength: 1, maxLength: 32 }), participant: participantSchema,
  position: t.Optional(t.Integer({ minimum: 0, maximum: 1023 })), creditedName: t.Optional(creditedName),
  sourceIdentity: t.Optional(relationSourceIdentity), attributionSupports: t.Optional(t.Array(relationAttributionSupport, { maxItems: 16 })) }, { additionalProperties: false });
export const allocatedParticipation = t.Object({ id: native, role: t.String(), participant: participantSchema,
  position: t.Optional(t.Integer()), creditedName: t.Optional(creditedName), sourceIdentity: t.Optional(relationSourceIdentity),
  attributionSupports: t.Array(relationAttributionSupport, { maxItems: 16 }) }, { additionalProperties: false });
