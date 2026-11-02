import type { KernelClient } from '@rezics/client';
import { isPlatformClosedError, isPlatformClosedProblem } from '../kernel/platform-closed';
import type { SessionEnv } from '../session/client';
import { prepareSession, viewerCredential } from '../session/request';
import { normalizeLibraryLabelName } from './subject-label-name';
import { subjectLabelInputIssue } from './subject-label-input';
import { readSubjectSlotSession, type SubjectLibraryReadIdentity } from './subject-slot';

export { normalizeLibraryLabelName } from './subject-label-name';

export type LibraryLabelSummary = NonNullable<
  Awaited<ReturnType<KernelClient['libraryLabels']['get']>>['data']
>['labels'][number];
export type SubjectLabel = { id: string; labelId: string; name: string; revision: number };
export type LabelAssignment = { id: string; revision: number };
type Result<T> = {
  status?: number;
  data?: T | null;
  error?: { status?: number; value?: unknown } | null;
  response?: Response;
};

export type SubjectLabelMutationInput =
  | { intent: 'create-and-assign'; subjectId: string; name: string; createKey?: string; idempotencyKey: string }
  | { intent: 'assign'; subjectId: string; labelId: string; idempotencyKey: string }
  | {
      intent: 'unassign' | 'restore';
      subjectId: string;
      labelId: string;
      assignmentId: string;
      revision: number;
      idempotencyKey: string;
    };

export type SubjectLabelMutationResult =
  | { ok: true; assignment: LabelAssignment; label?: LibraryLabelSummary; restoreRevision?: number }
  | {
      ok: false;
      reason:
        | 'conflict'
        | 'capacity'
        | 'restore-stale'
        | 'restore-expired'
        | 'restore-occupied'
        | 'restore-capacity'
        | 'closed'
        | 'signed-out'
        | 'unavailable';
    };

function statusOf(result: Result<unknown>): number | undefined {
  if (typeof result.status === 'number') return result.status;
  if (typeof result.error?.status === 'number') return result.error.status;
  return undefined;
}

function problemCode(result: Result<unknown>): string | undefined {
  const value = result.error?.value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const body = value as { code?: unknown; value?: unknown };
  const detail = body.value && typeof body.value === 'object' ? (body.value as { code?: unknown }) : body;
  return typeof detail.code === 'string' ? detail.code : undefined;
}

function refused(result: Result<unknown>, intent: SubjectLabelMutationInput['intent']): SubjectLabelMutationResult {
  const status = statusOf(result);
  const code = problemCode(result);
  if (isPlatformClosedProblem(status, result.error?.value)) return { ok: false, reason: 'closed' };
  if (code === 'conflict' && intent !== 'restore') return { ok: false, reason: 'conflict' };
  if (code === 'library_label_capacity') return { ok: false, reason: 'capacity' };
  if (intent === 'restore') {
    if (code === 'library_label_restore_stale') return { ok: false, reason: 'restore-stale' };
    if (code === 'library_label_restore_expired') return { ok: false, reason: 'restore-expired' };
    if (code === 'library_label_restore_occupied') return { ok: false, reason: 'restore-occupied' };
    if (code === 'library_label_restore_capacity') return { ok: false, reason: 'restore-capacity' };
  }
  return { ok: false, reason: 'unavailable' };
}

/** One bounded prefix request for a settled picker value. Out-of-date input is handled by the caller. */
export async function searchSubjectLabels(input: {
  client: KernelClient;
  request: Request;
  sessionEnv: Partial<SessionEnv>;
  query: string;
  cursor?: string;
}): Promise<{
  provenance?: SubjectLibraryReadIdentity & { query: string; cursor?: string };
  labels: LibraryLabelSummary[];
  next?: string | null;
  reason?: string;
  state: 'loaded' | 'closed' | 'signed-out' | 'unavailable';
}> {
  const identity = await readSubjectSlotSession(input.request, input.sessionEnv);
  if (identity.state !== 'signed-in')
    return { labels: [], state: identity.state === 'signed-out' ? 'signed-out' : 'unavailable' };
  const provenance = {
    viewer: identity.subject,
    csrfToken: identity.csrfToken,
    query: input.query,
    ...(input.cursor ? { cursor: input.cursor } : {}),
  };
  try {
    const result = await input.client.libraryLabels.get({
      query: { q: input.query, limit: 20, ...(input.cursor ? { cursor: input.cursor } : {}) },
      headers: { authorization: identity.authorization },
    });
    if (!result.error && result.data && statusOf(result) !== undefined && statusOf(result)! < 400)
      return { labels: result.data.labels, next: result.data.next, state: 'loaded', provenance };
    if (isPlatformClosedProblem(statusOf(result), result.error?.value))
      return { labels: [], state: 'closed', provenance };
    const reason = problemCode(result);
    return { labels: [], state: 'unavailable', provenance, ...(reason !== undefined ? { reason } : {}) };
  } catch (error) {
    return { labels: [], state: isPlatformClosedError(error) ? 'closed' : 'unavailable', provenance };
  }
}

/** One complete subject assignment page; callers gate it on the assignment-list exposure. */
export async function readSubjectLabelAssignments(
  client: KernelClient,
  subjectId: string,
  authorization: string,
): Promise<SubjectLabel[]> {
  const result = await client.libraryLabelAssignments.get({
    query: { subjectId, view: 'FULL', limit: 32 },
    headers: { authorization },
  });
  if (result.error || !result.data || (statusOf(result) ?? 500) >= 400) {
    if (isPlatformClosedProblem(statusOf(result), result.error?.value)) throw new Error('library labels closed');
    throw new Error('Library label assignments could not be read');
  }
  if (result.data.next) throw new Error('Library label assignments are incomplete');
  return result.data.assignments.map((row) => {
    if (!('label' in row)) throw new Error('FULL subject labels omitted their names');
    return { id: row.id, labelId: row.labelId, name: row.label.name, revision: row.revision };
  });
}

/** Makes one assignment or one removal/restore command; undo revisions always come from the response header. */
export async function applySubjectLabelMutation(
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: SubjectLabelMutationInput,
  client: KernelClient,
): Promise<SubjectLabelMutationResult> {
  try {
    const stale = await prepareSession(request, sessionEnv);
    const authorization = viewerCredential(request);
    if (stale || !authorization) return { ok: false, reason: 'signed-out' };
    const headers = { authorization, 'idempotency-key': input.idempotencyKey };
    if (input.intent === 'create-and-assign') {
      const name = normalizeLibraryLabelName(input.name);
      if (subjectLabelInputIssue(input.name)) return { ok: false, reason: 'unavailable' };
      const search = await client.libraryLabels.get({
        query: { q: input.name, limit: 20 },
        headers: { authorization },
      });
      if (search.error || !search.data || (statusOf(search) ?? 500) >= 400) return refused(search, input.intent);
      let label = search.data.labels.find((item) => normalizeLibraryLabelName(item.name) === name);
      if (!label) {
        const createHeaders = { authorization, 'idempotency-key': input.createKey ?? crypto.randomUUID() };
        const created = await client.libraryLabels.post({ name }, { headers: createHeaders });
        if (created.error || !created.data || (statusOf(created) ?? 500) >= 400) return refused(created, input.intent);
        label = { id: created.data.label.id, name, revision: created.data.label.revision };
      }
      const assigned = await client
        .libraryLabels({ id: label.id })
        .$assign.post({ subjectId: input.subjectId }, { headers });
      if (assigned.error || !assigned.data || (statusOf(assigned) ?? 500) >= 400)
        return refused(assigned, input.intent);
      return { ok: true, label, assignment: assigned.data.assignment };
    }
    if (input.intent === 'assign') {
      const assigned = await client
        .libraryLabels({ id: input.labelId })
        .$assign.post({ subjectId: input.subjectId }, { headers });
      if (assigned.error || !assigned.data || (statusOf(assigned) ?? 500) >= 400)
        return refused(assigned, input.intent);
      return { ok: true, assignment: assigned.data.assignment };
    }
    if (!Number.isSafeInteger(input.revision) || input.revision < 1 || !input.assignmentId)
      return { ok: false, reason: 'unavailable' };
    const body = { subjectId: input.subjectId, assignmentId: input.assignmentId, revision: input.revision };
    if (input.intent === 'unassign') {
      const removed = await client.libraryLabels({ id: input.labelId }).$unassign.post(body, { headers });
      if (removed.error || !removed.data?.deleted || statusOf(removed) === undefined || statusOf(removed)! >= 400)
        return refused(removed, input.intent);
      const header = removed.response?.headers.get('Library-Label-Assignment-Revision');
      const restoreRevision = header && /^[1-9]\d*$/.test(header) ? Number(header) : NaN;
      if (!Number.isSafeInteger(restoreRevision) || restoreRevision < 1) return { ok: false, reason: 'unavailable' };
      return { ok: true, assignment: { id: input.assignmentId, revision: input.revision }, restoreRevision };
    }
    const restored = await client.libraryLabels({ id: input.labelId }).$restoreAssignment.post(body, { headers });
    if (restored.error || !restored.data || (statusOf(restored) ?? 500) >= 400) return refused(restored, input.intent);
    return { ok: true, assignment: restored.data.assignment };
  } catch (error) {
    return { ok: false, reason: isPlatformClosedError(error) ? 'closed' : 'unavailable' };
  }
}

/** Resolves a plain HTML add form to the same normalized catalogue and assignment commands. */
export async function assignSubjectLabelByName(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: { subjectId: string; name: string },
): Promise<SubjectLabelMutationResult> {
  return applySubjectLabelMutation(
    request,
    sessionEnv,
    {
      intent: 'create-and-assign',
      subjectId: input.subjectId,
      name: input.name,
      createKey: crypto.randomUUID(),
      idempotencyKey: crypto.randomUUID(),
    },
    client,
  );
}
