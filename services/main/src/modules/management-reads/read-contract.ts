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
  t.Literal('contribution_submission'), t.Literal('correction_submission'),
  t.Literal('work_submission'), t.Literal('content-publication_submission')]);
export const moderationItem = t.Object({ id: readUuid, kind: moderationKind,
  state: t.Union([t.Literal('open'), t.Literal('closed')]),
  generation: t.String(), decisionHead: t.Nullable(readUuid), openedAt: t.String(),
  authorAgent: t.Nullable(readId), reasonCode: t.Nullable(t.String()),
  escalation: t.Nullable(escalationView),
  target: t.Object({ owner: t.String(), resource: t.String(), component: t.String() }),
  context: readId,
  submission: t.Nullable(t.Object({ revision: readUuid, state: submissionState,
    contribution: t.Nullable(readId), publicationDecision: t.Nullable(t.String()), selectedDraft: t.Nullable(readId),
    correctionOf: t.Nullable(readId) })) });

/** A report reason code (`routes/reports.ts`); the queue can be narrowed to cases one report gave it for. */
export const reportReason = t.String({ pattern: '^[a-z][a-z0-9_.-]{0,63}$' });

export const auditItem = t.Object({ id: readUuid, caseId: t.Nullable(readUuid),
  kind: t.Union([t.Literal('content_moderation'), t.Literal('rights_disposition'),
    t.Literal('organization_publication_rejection'), t.Literal('realm_management')]),
  /** A moderation decision's rationale, or a management change's reason. */
  reason: t.Nullable(t.String()),
  /** What a moderation decision's case was about; null for management changes and publication rejections. */
  target: t.Nullable(t.Object({ owner: t.String(), resource: t.String(), component: t.String() })),
  detail: t.Nullable(t.Object({ kind: t.Union([t.Literal('role'), t.Literal('assignment')]),
    role: t.Object({ id: readUuid, name: t.String() }), member: t.Nullable(readId),
    assigned: t.Nullable(t.Boolean()), validUntil: t.Nullable(t.String()),
    changes: t.Array(t.Object({ member: readId,
      gained: t.Array(t.String()), lost: t.Array(t.String()) })) })),
  outcome: t.String(), actingSubject: readId, decidedAt: t.String(),
  caseSequence: t.Nullable(t.String()) });

export const moderationPage = t.Object({ items: t.Array(moderationItem, { maxItems: 20 }),
  ...pageFields });

/**
 * What a moderator reads beside one queue page: one Access transaction
 * (two optional authority checks and one aggregate over at most `agents`
 * people, each count stopping at `historyRows`) and one Work read session
 * (one chapter-place query per Work, one summary batch, two credit queries
 * per Work or Book named, one name batch, one Hub batch and one mod-card
 * lookup).
 */
export const MODERATION_CONTEXT_COST = { agents: 20, works: 20, historyRows: 1_000, sqlStatements: 6,
  graphCalls: 72, authors: 8, hubCharacters: 4_000, statementTimeoutMs: 5_000 } as const;

const historyCount = t.Integer({ minimum: 0, maximum: MODERATION_CONTEXT_COST.historyRows });
/**
 * A submitter's or reporter's record in this Realm. Submissions show to
 * reviewers and reports to moderators, as the queue does; a count that
 * reached `historyRows` is `capped`.
 */
export const personContext = t.Object({ agent: readId,
  membership: t.Object({ state: t.Union([t.Literal('joined'), t.Literal('left'), t.Literal('not_joined')]),
    joinedAt: t.Nullable(t.String()), banned: t.Boolean(), bannedUntil: t.Nullable(t.String()) }),
  submissions: t.Nullable(t.Object({ open: historyCount, accepted: historyCount, rejected: historyCount,
    changesRequested: historyCount, withdrawn: historyCount, total: historyCount, capped: t.Boolean() })),
  reports: t.Nullable(t.Object({ open: historyCount, upheld: historyCount, dismissed: historyCount,
    total: historyCount, capped: t.Boolean() })) });
/**
 * What a queue item's Work is beyond its header: its place when it is a
 * chapter, who wrote it, and a mod's or prompt's own facts. A chapter's place
 * in a Book the reader can read is named even when the chapter's own record
 * is not public, as the Book's contents already show it; its authors are then
 * the Book's.
 */
export const workContext = t.Object({ work: readId,
  partOf: t.Nullable(t.Object({ work: readId, occurrence: t.Nullable(readId) })),
  authors: t.Array(t.Object({ agent: t.Nullable(readId), name: t.String() }),
    { maxItems: MODERATION_CONTEXT_COST.authors }),
  mod: t.Nullable(t.Object({ game: t.String(), gameVersions: t.Array(t.String(), { maxItems: 8 }),
    loaders: t.Array(t.String(), { maxItems: 8 }), latestRelease: t.Nullable(t.String()) })),
  /** A public prompt's text or a public skill's description and instructions, cut at `hubCharacters`. */
  hub: t.Nullable(t.Object({ kind: t.Union([t.Literal('prompt'), t.Literal('skill-package')]),
    summary: t.String(), text: t.String(), truncated: t.Boolean(),
    declaredModels: t.Array(t.String(), { maxItems: 64 }) })) });
export const moderationContext = t.Object({ profile: t.Literal('moderation-context-v1'),
  people: t.Array(personContext, { maxItems: MODERATION_CONTEXT_COST.agents }),
  works: t.Array(workContext, { maxItems: MODERATION_CONTEXT_COST.works }) });
export const auditPage = t.Object({ items: t.Array(auditItem, { maxItems: 20 }),
  ...pageFields });

// The durable Realm Access revision is appended to the graph sequence.
export type ManagementPosition = Static<typeof readPosition>;
