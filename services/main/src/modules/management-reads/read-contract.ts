import { t } from 'elysia';
import type { Static } from 'typebox';
import { pageFields, readId, readPosition, readUuid } from '../work/read-contract.ts';
import { submissionState } from '../realm-submission/schema.ts';
import { escalationView } from '../realm-admin/contract.ts';

export const MANAGEMENT_READ_COST = { pageSize: 20, graphCalls: 2, graphBytes: 16 * 1024,
  sqlStatements: 13, escalationPointReads: 21, statementTimeoutMs: 5_000, deadlineMs: 10_000 } as const;

export const managementQuery = { actingSubject: readId,
  limit: t.Optional(t.Integer({ minimum: 1, maximum: MANAGEMENT_READ_COST.pageSize })),
  cursor: t.Optional(t.String({ minLength: 1, maxLength: 2048 })) };

export const moderationKind = t.Union([t.Literal('content_report'), t.Literal('rights_complaint'),
  t.Literal('contribution_submission'), t.Literal('correction_submission')]);
export const moderationItem = t.Object({ id: readUuid, kind: moderationKind,
  state: t.Union([t.Literal('open'), t.Literal('closed')]),
  generation: t.String(), decisionHead: t.Nullable(readUuid), openedAt: t.String(),
  authorAgent: t.Nullable(readId), reasonCode: t.Nullable(t.String()),
  escalation: t.Nullable(escalationView),
  target: t.Object({ owner: t.String(), resource: t.String(), component: t.String() }),
  context: readId,
  submission: t.Nullable(t.Object({ revision: readUuid, state: submissionState,
    contribution: readId, publicationDecision: readId, selectedDraft: readId,
    correctionOf: t.Nullable(readId) })) });

export const auditItem = t.Object({ id: readUuid, caseId: t.Nullable(readUuid),
  kind: t.Union([t.Literal('content_moderation'), t.Literal('rights_disposition'),
    t.Literal('organization_publication_rejection'), t.Literal('realm_management')]),
  reason: t.Nullable(t.String()),
  outcome: t.String(), actingSubject: readId, decidedAt: t.String(),
  caseSequence: t.Nullable(t.String()) });

export const moderationPage = t.Object({ items: t.Array(moderationItem, { maxItems: 20 }),
  ...pageFields });
export const auditPage = t.Object({ items: t.Array(auditItem, { maxItems: 20 }),
  ...pageFields });

// The durable Realm Access revision is appended to the graph sequence.
export type ManagementPosition = Static<typeof readPosition>;
