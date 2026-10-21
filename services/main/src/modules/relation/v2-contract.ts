import { t } from 'elysia';
import type { Static, StaticDecode, StaticEncode } from 'typebox';
import { semanticParticipantSchema as participantSchema } from '../semantic/value-contract.ts';
import type { CreditAttributionSupport } from '../work/credit-association-state.ts';

const native = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });
const text = (maxLength: number) => t.String({ minLength: 1, maxLength, pattern: '^[^\\u0000-\\u001f\\u007f]+$' });
export const relationSourceIdentity = t.Object({ provider: text(64), namespace: text(64), key: text(200),
  alias: t.Nullable(text(200)), eid: t.Nullable(text(200)), note: t.Nullable(text(2000)) }, { additionalProperties: false });
const relationAttributionSupportSchema = t.Object({ basis: t.Union([
  t.Object({ kind: t.Literal('source-credit'), support: native }, { additionalProperties: false }),
  t.Object({ kind: t.Literal('native-credit'), credit: native, revision: native }, { additionalProperties: false }),
  t.Object({ kind: t.Literal('source-binding'), binding: native }, { additionalProperties: false }),
  t.Object({ kind: t.Literal('selected-publication'), decision: native }, { additionalProperties: false }),
]), fields: t.Array(t.Union([t.Literal('creditedName'), t.Literal('provider'), t.Literal('namespace'),
  t.Literal('key'), t.Literal('alias'), t.Literal('eid'), t.Literal('note')]),
  { minItems: 1, maxItems: 7, uniqueItems: true }),
evidence: t.Array(text(2048), { minItems: 0, maxItems: 16, uniqueItems: true }) }, { additionalProperties: false,
  anyOf: [
    { properties: { evidence: { minItems: 1 } } },
    { properties: { basis: { properties: { kind: { const: 'native-credit' } } },
      fields: { items: { enum: ['provider', 'namespace', 'key'] } } } },
  ],
});
type Assert<Condition extends true> = Condition;
/** Keep the owner contract exact while sharing its static type across native and retained routes. */
export type RelationAttributionContractMatchesSchema = Assert<
  [StaticEncode<typeof relationAttributionSupportSchema>, StaticDecode<typeof relationAttributionSupportSchema>] extends
    [CreditAttributionSupport, CreditAttributionSupport]
    ? [CreditAttributionSupport, CreditAttributionSupport] extends
      [StaticEncode<typeof relationAttributionSupportSchema>, StaticDecode<typeof relationAttributionSupportSchema>]
      ? true : false
    : false>;
export const relationAttributionSupport = t.Unsafe<CreditAttributionSupport>(relationAttributionSupportSchema);
const creditedName = t.Object({ lexical: t.String({ minLength: 1, maxLength: 200 }), language: t.String({ minLength: 2, maxLength: 35 }) }, { additionalProperties: false });
const attributedParticipationSchema = t.Object({ role: t.String({ minLength: 1, maxLength: 32 }), participant: participantSchema,
  position: t.Optional(t.Integer({ minimum: 0, maximum: 1023 })), creditedName: t.Optional(creditedName),
  sourceIdentity: t.Optional(relationSourceIdentity), attributionSupports: t.Optional(t.Array(relationAttributionSupport, { maxItems: 16 })) }, { additionalProperties: false });
const allocatedParticipationSchema = t.Object({ id: native, role: t.String(), participant: participantSchema,
  position: t.Optional(t.Integer()), creditedName: t.Optional(creditedName), sourceIdentity: t.Optional(relationSourceIdentity),
  attributionSupports: t.Array(relationAttributionSupport, { maxItems: 16 }) }, { additionalProperties: false });
// Elysia composes these leaves repeatedly in native/retained route unions.
// Keep the exact validator and its inferred value while bounding schema inference.
export const attributedParticipation = t.Unsafe<Static<typeof attributedParticipationSchema>>(attributedParticipationSchema);
export const allocatedParticipation = t.Unsafe<Static<typeof allocatedParticipationSchema>>(allocatedParticipationSchema);
