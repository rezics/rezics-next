import { t } from 'elysia';

const native = t.String({ pattern: '^https://rezics.com/id/[0-9a-f-]{36}$' });
export const authorCreditBody = t.Object({ profile: t.Literal('source-author-credit-adoption-v1'),
  proposal: native, conversion: native, expectedHead: native, actingSubject: native,
  occurrence: t.String({ pattern: '^urn:rezics:source-occurrence:[0-9a-f]{64}$' }),
  sourceOrdinal: t.Integer({ minimum: 0, maximum: 127 }), nativeOrdinal: t.Integer({ minimum: 0, maximum: 127 }),
  confirmedSourceKey: t.String({ maxLength: 200 }), confirmedRoleKey: t.Nullable(t.String({ minLength: 1, maxLength: 200 })),
  baseSupport: t.Nullable(native), correspondence: t.Nullable(native), confirmedUse: t.Literal('factual-reference-only'),
}, { additionalProperties: false });
export const nativeAuthorCreditResult = t.Object({ profile: t.Literal('work-author-credit-v1'),
  work: native, credit: native, revision: native, expectedHead: native, actingSubject: native,
  sourceKey: t.String(), sourceRoleKey: t.Nullable(t.String()), nativeOrdinal: t.Integer(),
  role: t.Literal('author'), participantKind: t.Literal('external-reference'),
  provider: t.Literal('open-library'), namespace: t.Literal('author'), control: t.Literal('human-confirmed'),
  rightsStatus: t.Literal('undetermined'), dataEpoch: t.String(), sequence: t.String() });
export const authorCreditSupportResult = t.Object({ profile: t.Literal('source-author-credit-support-v1'),
  state: t.Union([t.Literal('recorded'), t.Literal('withdrawn')]), support: native, work: native,
  credit: nativeAuthorCreditResult, proposal: native, conversion: native, record: native, observation: native,
  sourceOccurrence: t.String(), sourceOrdinal: t.Integer(), sourceKey: t.String(), sourceRoleKey: t.Nullable(t.String()),
  correspondence: t.Nullable(native), baseSupport: t.Nullable(native),
  correspondenceKind: t.Union(['initial', 'unique-key', 'explicit', 'separate-source'].map(value => t.Literal(value))),
  sourceGraphReceipt: t.String(), nativeReceipt: t.String(),
  headGuarantee: t.Union([t.Literal('transaction-guarded'), t.Literal('verified-before-commit')]),
  rightsEvidence: t.Object({ basis: t.String(), note: t.String() }), rightsStatus: t.Literal('undetermined'),
  createdAt: t.String(), withdrawal: t.Nullable(t.Object({ withdrawal: native, reason: t.String(), createdAt: t.String() })) });
export const authorCreditWriteResult = t.Object({ support: authorCreditSupportResult, replayed: t.Boolean() });
