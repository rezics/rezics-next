import { t } from 'elysia';
import type { Static } from 'typebox';
import { readId } from '../work/read-contract.ts';
import { resolvedTarget } from '../target/contract.ts';
import { REASONS } from './policy.ts';

export const labels = t.Union([
  t.Tuple([]),
  t.Tuple([t.Literal('r15')]),
  t.Tuple([t.Literal('r18')]),
  t.Tuple([t.Literal('r18g')]),
  t.Tuple([t.Literal('r18'), t.Literal('r18g')]),
]);
const unassessed = t.Object(
  { status: t.Literal('unassessed'), displayLabel: t.Literal('Not assessed') },
  { additionalProperties: false },
);
const assessedFields = {
  status: t.Literal('assessed'),
  revision: readId,
  predecessor: t.Nullable(readId),
  labels,
  basis: t.Union([t.Literal('author'), t.Literal('platform'), t.Literal('source')]),
  sourceId: t.Nullable(t.String({ maxLength: 512 })),
  createdAt: t.String(),
};
/** Commands return their assessor; batch reads disclose it only to moderators. */
export const assessment = t.Union([
  unassessed,
  t.Object({ ...assessedFields, assessor: readId }, { additionalProperties: false }),
]);
export const readAssessment = t.Union([
  unassessed,
  t.Object({ ...assessedFields, assessor: t.Optional(readId) }, { additionalProperties: false }),
]);
export type StoredAssessment = Static<typeof assessment>;
export type ReadAssessment = Static<typeof readAssessment>;
export type Assessed = Extract<StoredAssessment, { status: 'assessed' }>;
export const command = t.Object(
  {
    actingSubject: readId,
    expectedRevision: t.Nullable(readId),
    labels,
    basis: t.Union([t.Literal('author'), t.Literal('platform')]),
  },
  { additionalProperties: false },
);
export type Command = Static<typeof command>;
export const commandResult = t.Object({ assessment, replayed: t.Boolean() });
export const reads = t.Object(
  { targets: t.Array(readId, { minItems: 1, maxItems: 64 }), actingSubject: t.Optional(readId) },
  { additionalProperties: false },
);
export const evidence = t.Object({
  signedIn: t.Boolean(),
  age: t.Literal('unknown'),
  country: t.Null(),
  optIns: t.Object({
    sexual: t.Literal(false),
    grotesque: t.Literal(false),
    available: t.Literal(false),
    reason: t.Literal('age_evidence_unavailable'),
  }),
});
export const readsResult = t.Object({
  viewer: evidence,
  items: t.Array(
    t.Object({
      target: resolvedTarget,
      assessment: readAssessment,
      eligible: t.Boolean(),
      reasons: t.Array(t.Union(REASONS.map((reason) => t.Literal(reason)))),
    }),
    { maxItems: 64 },
  ),
});
