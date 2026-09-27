import { t } from 'elysia';
import type { Static } from 'typebox';
import { pageFields, readId, readPosition, readUuid } from '../work/read-contract.ts';

export const MANAGEMENT_READ_COST = { pageSize: 20, graphCalls: 2, graphBytes: 16 * 1024,
  sqlStatements: 10, statementTimeoutMs: 5_000, deadlineMs: 10_000 } as const;

export const managementQuery = { actingSubject: readId,
  limit: t.Optional(t.Integer({ minimum: 1, maximum: MANAGEMENT_READ_COST.pageSize })),
  cursor: t.Optional(t.String({ minLength: 1, maxLength: 2048 })) };

export const moderationItem = t.Object({ id: readUuid, kind: t.Union([
  t.Literal('content_report'), t.Literal('rights_complaint')]),
  state: t.Union([t.Literal('open'), t.Literal('closed')]),
  generation: t.String(), decisionHead: t.Nullable(readUuid), openedAt: t.String(),
  target: t.Object({ owner: t.String(), resource: t.String(), component: t.String() }),
  context: readId });

export const auditItem = t.Object({ id: readUuid, caseId: t.Nullable(readUuid),
  kind: t.Union([t.Literal('content_moderation'), t.Literal('rights_disposition'),
    t.Literal('organization_publication_rejection')]),
  outcome: t.String(), actingSubject: readId, decidedAt: t.String(),
  caseSequence: t.Nullable(t.String()) });

export const moderationPage = t.Object({ items: t.Array(moderationItem, { maxItems: 20 }),
  ...pageFields });
export const auditPage = t.Object({ items: t.Array(auditItem, { maxItems: 20 }),
  ...pageFields });

// The selected Access head identities are appended to the graph sequence.
export type ManagementPosition = Static<typeof readPosition>;
