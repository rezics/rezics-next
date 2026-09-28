import { t } from 'elysia';
import type { Static } from 'typebox';
import { pageFields, readId, readUuid } from '../work/read-contract.ts';

// One Realm per command: clients submit to several Realms independently, retaining
// each receipt. No implicit batch rollback or cross-Realm authority is promised.
export const SUBMISSION_COST = { pageSize: 20, candidateRows: 2, candidateBytes: 8192,
  commandGraphCalls: 24, commandGraphBytes: 512 * 1024, deadlineMs: 30_000,
  ownerSqlStatements: 32, readSqlStatements: 12, statementTimeoutMs: 5_000, lockTimeoutMs: 2_000 } as const;
// Submit: one admission, one reservation and at most one policy selection.
// Withdraw: one admission and one mutation. Review: one review
// admission, at most one adoption admission and one exact selection command.
// SQL counts cover this owner; the reused Access/selection owners retain theirs.
// Author/detail reads have no graph calls, no totals, and at most 21/1 rows.
export const submissionState = t.Union((['pending', 'deciding', 'accepted', 'rejected',
  'changes-requested', 'withdrawn', 'stale'] as const).map(value => t.Literal(value)));
export const submissionKind = t.Union([t.Literal('contribution'), t.Literal('correction'),
  t.Literal('work'), t.Literal('content-publication')]);
const textSubmissionInput = t.Object({ actingSubject: readId,
  kind: t.Union([t.Literal('contribution'), t.Literal('correction')]),
  work: readId, mainVersion: readId, contribution: readId, publicationDecision: readId,
  selectedDraft: readId, correctionOf: t.Nullable(readId) }, { additionalProperties: false });
export type SubmissionInput = Static<typeof textSubmissionInput>;
const resourceFields = { actingSubject: readId, work: readId, mainVersion: readId, workRevision: readId };
export const resourceSubmissionInput = t.Union([
  t.Object({ ...resourceFields, kind: t.Literal('work') }, { additionalProperties: false }),
  t.Object({ ...resourceFields, kind: t.Literal('content-publication'),
    variant: t.String({ pattern: '^urn:rezics:variant:[0-9a-f-]{36}$' }),
    publicationDecision: t.String({ pattern: '^urn:rezics:content-publication:[0-9a-f]{64}$' }),
    contentRevision: readUuid }, { additionalProperties: false }),
]);
export type ResourceSubmissionInput = Static<typeof resourceSubmissionInput>;
export const submissionInput = t.Union([textSubmissionInput, resourceSubmissionInput]);
export type SubmissionRequest = Static<typeof submissionInput>;
export const decisionInput = t.Object({ actingSubject: readId, expectedRevision: readUuid,
  outcome: t.Union([t.Literal('accept'), t.Literal('reject'), t.Literal('request-changes')]),
  expectedSelectionHead: t.Nullable(readId),
  publicReason: t.Nullable(t.String({ minLength: 1, maxLength: 2000 })),
  internalNote: t.Nullable(t.String({ maxLength: 4000 })) }, { additionalProperties: false });
export type DecisionInput = Static<typeof decisionInput>;
export const withdrawalInput = t.Object({ actingSubject: readId, expectedRevision: readUuid },
  { additionalProperties: false });
export type WithdrawalInput = Static<typeof withdrawalInput>;
export const submissionView = t.Object({ id: readUuid, realm: readId, kind: submissionKind,
  work: readId, mainVersion: readId, contribution: t.Nullable(readId), publicationDecision: t.Nullable(t.String()),
  selectedDraft: t.Nullable(readId), correctionOf: t.Nullable(readId), submittingAgent: readId,
  target: t.Nullable(resourceSubmissionInput),
  state: submissionState, revision: readUuid, generation: t.String(),
  reviewer: t.Nullable(readId), publicReason: t.Nullable(t.String()),
  selection: t.Nullable(readId), adoptionReceipt: t.Nullable(t.String()),
  openedAt: t.String(), updatedAt: t.String() });
export type SubmissionView = Static<typeof submissionView>;
export const submissionResult = t.Object({ submission: submissionView, replayed: t.Boolean() });
export const submissionPage = t.Object({ items: t.Array(submissionView, { maxItems: 20 }), ...pageFields });
export const submissionQuery = { actingSubject: readId, state: t.Optional(submissionState),
  limit: t.Optional(t.Integer({ minimum: 1, maximum: 20 })),
  cursor: t.Optional(t.String({ minLength: 1, maxLength: 2048 })) };

export class SubmissionMissing extends Error {}
export class SubmissionStale extends Error {}
export class SubmissionInvalid extends Error {}
export class SubmissionUnavailable extends Error {}

export interface SubmissionRow {
  id: string; realm: string; kind: SubmissionView['kind']; work: string;
  main_version: string; contribution: string | null; publication_decision: string | null; selected_draft: string | null;
  target: ResourceSubmissionInput | null;
  correction_of: string | null; submitting_agent: string; state: SubmissionView['state'];
  revision: string; generation: string; decision_operation: string | null;
  reviewer: string | null; public_reason: string | null; internal_note: string | null;
  selection: string | null; adoption_receipt: string | null; opened_at: Date; updated_at: Date;
}
// Explicit projection: internal notes never enter author responses or stored replay results.
export const viewSubmission = (row: SubmissionRow): SubmissionView => ({ id: row.id,
  realm: row.realm, kind: row.kind, work: row.work, mainVersion: row.main_version, target: row.target ?? null,
  contribution: row.contribution, publicationDecision: row.publication_decision,
  selectedDraft: row.selected_draft, correctionOf: row.correction_of,
  submittingAgent: row.submitting_agent, state: row.state, revision: row.revision,
  generation: row.generation, reviewer: row.reviewer, publicReason: row.public_reason,
  selection: row.selection, adoptionReceipt: row.adoption_receipt,
  openedAt: row.opened_at.toISOString(), updatedAt: row.updated_at.toISOString() });
