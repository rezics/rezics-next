import { t } from 'elysia';
import type { Static } from 'typebox';
import { relationAttributionSupport } from './v2-contract.ts';

const native = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });
const text = (maxLength: number) => t.String({ minLength: 1, maxLength, pattern: '^[^\\u0000-\\u001f\\u007f]+$' });
const storedOrigin = t.Object({ kind: t.Literal('stored-credit'), revision: native }, { additionalProperties: false });
const sourceOrigin = t.Union([
  t.Object({ kind: t.Literal('source-binding'), binding: native, proposal: native, conversion: native,
    record: native, observation: native, sourceOccurrence: text(2048),
    sourceOrdinal: t.Integer({ minimum: 0, maximum: 127 }) }, { additionalProperties: false }),
  t.Object({ kind: t.Literal('selected-publication'), decision: native,
    source: t.String({ pattern: '^urn:rezics:work-source:[^\\s<>"{}|\\^`]+$', maxLength: 2048 }),
    record: native, observation: native }, { additionalProperties: false }),
]);
export const retainedCreditOrigin = t.Union([storedOrigin, sourceOrigin]);
/** The public command selects existing owners. Native identity, role, ordinal,
 * participant, field values and command receipts are never request witnesses. */
export const retainedRelationInput = t.Object({
  profile: t.Literal('relation-change-v2'), mode: t.Literal('bind-retained-credit'),
  retained: t.Union([
    t.Object({ profile: t.Union([t.Literal('work-author-credit-v1'), t.Literal('native-agent-credit-v1')]),
      credit: native, origin: storedOrigin }, { additionalProperties: false }),
    t.Object({ profile: t.Literal('source-reported-credit-v1'), credit: native, origin: sourceOrigin }, { additionalProperties: false }),
  ]),
  expectedAssociationHead: t.Nullable(native), mappingRevision: native,
  attributionSupports: t.Array(relationAttributionSupport, { maxItems: 16, uniqueItems: true }),
  actingSubject: native,
}, { additionalProperties: false });
export type RetainedRelationInput = Static<typeof retainedRelationInput>;
