import type { KernelClient } from '@rezics/client';
import { MediaProblem } from '../media/kernel';
import { isPlatformClosedError, isPlatformClosedProblem, PlatformClosedError } from '../kernel/platform-closed';
import type { SessionEnv } from '../session/client';
import { prepareSession, viewerCredential } from '../session/request';
import type { CollectionVisibility } from './reads';

export type CollectionWriteResult =
  | { ok: true; id: string; revision?: number; undo?: CollectionMemberUndo }
  | {
      ok: false;
      reason:
        | 'closed'
        | 'conflict'
        | 'forbidden'
        | 'full'
        | 'invalid'
        | 'unauthorized'
        | 'unavailable'
        | 'expired'
        | 'occupied'
        | 'unsupported';
    };

/** Receipt-bound deletion episode. The native restore command owns the original 720-hour deadline. */
export type CollectionMemberUndo = { collectionId: string; memberId: string; deletionId: string; revision: number };
export type CollectionPresentationSelection = { presentationKind?: string | null; coverMediaId?: string | null };

type ViewerAction = { action: string; operations: string[] };
export type CollectionViewerActions = { state: 'ready'; actions: ViewerAction[] } | { state: 'unavailable' };

/** One exact-resource native action read, using the same credential as the Collection read. */
export async function readCollectionViewerActions(
  client: KernelClient,
  id: string,
  authorization: string | null,
): Promise<CollectionViewerActions> {
  try {
    const result = await client.viewerActions.post(
      { resources: [{ type: 'library.collection', id }] },
      authorization ? { headers: { authorization } } : {},
    );
    if (result.error || result.status !== 200) return { state: 'unavailable' };
    const resource = result.data?.resources.find((value) => value.type === 'library.collection' && value.id === id);
    return resource && 'viewerActions' in resource
      ? { state: 'ready', actions: resource.viewerActions }
      : { state: 'unavailable' };
  } catch {
    return { state: 'unavailable' };
  }
}

export function admitsCollectionOperation(
  viewerActions: CollectionViewerActions | undefined,
  action: string,
  operation: string,
): boolean {
  return (
    viewerActions?.state === 'ready' &&
    viewerActions.actions.some((entry) => entry.action === action && entry.operations.includes(operation))
  );
}

type LibraryFailure = {
  data?: unknown;
  error?: { status?: number; value?: unknown } | null;
  status?: number;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function kernelHeaders(authorization: string, idempotencyKey: string): { 'idempotency-key': string } {
  return { authorization, 'idempotency-key': idempotencyKey } as { 'idempotency-key': string };
}

/**
 * One session read. A write stops here when the cookie, origin or `X-CSRF-Token` header does not match; the token is
 * accepted from the header only.
 */
export async function writeSession(
  request: Request,
  sessionEnv: Partial<SessionEnv>,
): Promise<{ authorization: string } | Extract<CollectionWriteResult, { ok: false }>> {
  try {
    const stale = await prepareSession(request, sessionEnv);
    const authorization = viewerCredential(request);
    if (stale || !authorization) return { ok: false, reason: 'unauthorized' };
    return { authorization };
  } catch (error) {
    if (error instanceof MediaProblem && error.problem.status === 403) return { ok: false, reason: 'forbidden' };
    return { ok: false, reason: 'unavailable' };
  }
}

export function refused(error: unknown): Extract<CollectionWriteResult, { ok: false }> {
  if (isPlatformClosedError(error)) return { ok: false, reason: 'closed' };
  return { ok: false, reason: 'unavailable' };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function problemCode(body: unknown): string {
  return isRecord(body) && typeof body.code === 'string' ? body.code : '';
}

export function fromKernel(result: LibraryFailure, id: string): CollectionWriteResult {
  const status = typeof result.status === 'number' ? result.status : result.error?.status;
  const body = result.error?.value;
  if (isPlatformClosedProblem(status, body)) throw new PlatformClosedError(status ?? 403, body);
  const code = problemCode(body);
  if (code === 'member_restore_expired') return { ok: false, reason: 'expired' };
  if (code === 'member_restore_occupied') return { ok: false, reason: 'occupied' };
  if (code === 'collection_move_unsupported') return { ok: false, reason: 'unsupported' };
  if (code === 'collection_full') return { ok: false, reason: 'full' };
  const succeeded = status === 204 || (!result.error && status !== undefined && status < 400);
  if (succeeded) return id.length > 0 ? { ok: true, id } : { ok: false, reason: 'unavailable' };
  if (code === 'conflict' || status === 409) return { ok: false, reason: 'conflict' };
  if (status === 401 || status === 403) return { ok: false, reason: 'forbidden' };
  if (status === 400 || status === 404 || status === 422) return { ok: false, reason: 'invalid' };
  return { ok: false, reason: 'unavailable' };
}

export function asSession(
  value: { authorization: string } | CollectionWriteResult,
): value is { authorization: string } {
  return 'authorization' in value;
}

export function visibilityOf(value: unknown): CollectionVisibility | null {
  if (value === 'private' || value === 'public' || value === 'unlisted') return value;
  return null;
}

function createdId(data: unknown): string {
  if (!isRecord(data) || !isRecord(data.collection) || typeof data.collection.id !== 'string') return '';
  return data.collection.id;
}

function createdMemberId(data: unknown): string {
  if (!isRecord(data) || !isRecord(data.member) || typeof data.member.id !== 'string') return '';
  return data.member.id;
}

export async function createCollectionRecord(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: {
    title: string;
    description: string;
    visibility: string;
    idempotencyKey: string;
  } & CollectionPresentationSelection,
): Promise<CollectionWriteResult> {
  const visibility = visibilityOf(input.visibility);
  if (!input.title.trim() || input.title.length > 512 || !visibility || !uuid.test(input.idempotencyKey)) {
    return { ok: false, reason: 'invalid' };
  }
  const session = await writeSession(request, sessionEnv);
  if (!asSession(session)) return session;
  try {
    const result = await client.collections.post(
      {
        title: input.title,
        description: input.description.length > 0 ? input.description : null,
        visibility,
        ...selectionOf(input),
      },
      { headers: kernelHeaders(session.authorization, input.idempotencyKey) },
    );
    return fromKernel(result, createdId(result.data));
  } catch (error) {
    return refused(error);
  }
}

export async function updateCollectionRecord(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: {
    collectionId: string;
    revision: number;
    title: string;
    description: string;
    visibility: string;
    idempotencyKey: string;
  } & CollectionPresentationSelection,
  includeRevision = false,
): Promise<CollectionWriteResult> {
  const visibility = visibilityOf(input.visibility);
  if (
    !input.collectionId ||
    !Number.isInteger(input.revision) ||
    !input.title.trim() ||
    input.title.length > 512 ||
    !visibility ||
    !uuid.test(input.idempotencyKey)
  ) {
    return { ok: false, reason: 'invalid' };
  }
  const session = await writeSession(request, sessionEnv);
  if (!asSession(session)) return session;
  try {
    const result = await client.collections({ collectionId: input.collectionId }).patch(
      {
        revision: input.revision,
        title: input.title,
        description: input.description.length > 0 ? input.description : null,
        visibility,
        ...selectionOf(input),
      },
      { headers: kernelHeaders(session.authorization, input.idempotencyKey) },
    );
    const outcome = fromKernel(result, input.collectionId);
    const revision = result.data?.collection.revision;
    return outcome.ok &&
      includeRevision &&
      typeof revision === 'number' &&
      Number.isSafeInteger(revision) &&
      revision > 0
      ? { ...outcome, revision }
      : outcome;
  } catch (error) {
    return refused(error);
  }
}

function selectionOf(input: CollectionPresentationSelection): CollectionPresentationSelection {
  return {
    ...(input.presentationKind === undefined ? {} : { presentationKind: input.presentationKind }),
    ...(input.coverMediaId === undefined ? {} : { coverMediaId: input.coverMediaId }),
  };
}

export async function addCollectionMemberRecord(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: { collectionId: string; subjectId: string; note: string | null; idempotencyKey: string },
): Promise<CollectionWriteResult> {
  if (!input.collectionId || !input.subjectId || !uuid.test(input.idempotencyKey)) {
    return { ok: false, reason: 'invalid' };
  }
  if (input.note !== null && (typeof input.note !== 'string' || input.note.length > 20_000)) {
    return { ok: false, reason: 'invalid' };
  }
  const session = await writeSession(request, sessionEnv);
  if (!asSession(session)) return session;
  try {
    const result = await client
      .collections({ collectionId: input.collectionId })
      .members.post(
        { subjectId: input.subjectId, ...(input.note === null ? {} : { note: input.note }) },
        { headers: kernelHeaders(session.authorization, input.idempotencyKey) as never },
      );
    return fromKernel(result, createdMemberId(result.data));
  } catch (error) {
    return refused(error);
  }
}

export async function deleteCollectionRecord(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: { collectionId: string; revision: number; idempotencyKey: string },
): Promise<CollectionWriteResult> {
  if (!input.collectionId || !Number.isInteger(input.revision) || !uuid.test(input.idempotencyKey)) {
    return { ok: false, reason: 'invalid' };
  }
  const session = await writeSession(request, sessionEnv);
  if (!asSession(session)) return session;
  try {
    const result = await client.collections({ collectionId: input.collectionId }).delete(undefined, {
      query: { revision: input.revision },
      headers: kernelHeaders(session.authorization, input.idempotencyKey),
    });
    return fromKernel(result, input.collectionId);
  } catch (error) {
    return refused(error);
  }
}

export async function moveCollectionMemberRecord(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: { collectionId: string; memberId: string; after?: string | null; idempotencyKey: string },
): Promise<CollectionWriteResult> {
  if (
    !isRecord(input) ||
    Object.keys(input).some((key) => !['collectionId', 'memberId', 'after', 'idempotencyKey'].includes(key)) ||
    ![input.collectionId, input.memberId].every((id) => typeof id === 'string' && id.length > 0 && id.length <= 128) ||
    !uuid.test(input.idempotencyKey)
  ) {
    return { ok: false, reason: 'invalid' };
  }
  if (
    input.after !== undefined &&
    input.after !== null &&
    (typeof input.after !== 'string' || input.after.length === 0 || input.after.length > 128)
  )
    return { ok: false, reason: 'invalid' };
  const session = await writeSession(request, sessionEnv);
  if (!asSession(session)) return session;
  try {
    const post = client.collections({ collectionId: input.collectionId }).members({ memberId: input.memberId })
      .$move.post;
    // Additive native body until the controller derives the client; preserve its options and response types.
    const move = post as (
      body: { after?: string | null },
      options: Parameters<typeof post>[1],
    ) => ReturnType<typeof post>;
    const result = await move(input.after === undefined ? {} : { after: input.after }, {
      headers: kernelHeaders(session.authorization, input.idempotencyKey),
    });
    return fromKernel(result, input.memberId);
  } catch (error) {
    return refused(error);
  }
}

export async function updateMemberNoteRecord(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: { collectionId: string; memberId: string; note: string | null; idempotencyKey: string },
): Promise<CollectionWriteResult> {
  if (!input.collectionId || !input.memberId || !uuid.test(input.idempotencyKey)) {
    return { ok: false, reason: 'invalid' };
  }
  if (input.note !== null && typeof input.note !== 'string') return { ok: false, reason: 'invalid' };
  const session = await writeSession(request, sessionEnv);
  if (!asSession(session)) return session;
  try {
    const result = await client
      .collections({ collectionId: input.collectionId })
      .members({ memberId: input.memberId })
      .patch({ note: input.note }, { headers: kernelHeaders(session.authorization, input.idempotencyKey) });
    return fromKernel(result, input.memberId);
  } catch (error) {
    return refused(error);
  }
}

export async function removeCollectionMemberWithUndoRecord(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: { collectionId: string; memberId: string; revision: number; idempotencyKey: string },
): Promise<CollectionWriteResult> {
  if (
    !input.collectionId ||
    !input.memberId ||
    !Number.isSafeInteger(input.revision) ||
    input.revision < 1 ||
    !uuid.test(input.idempotencyKey)
  ) {
    return { ok: false, reason: 'invalid' };
  }
  const session = await writeSession(request, sessionEnv);
  if (!asSession(session)) return session;
  try {
    const result = await client
      .collections({ collectionId: input.collectionId })
      .members({ memberId: input.memberId })
      .delete(undefined, {
        query: { revision: input.revision },
        headers: kernelHeaders(session.authorization, input.idempotencyKey),
      });
    const outcome = fromKernel(result, input.memberId);
    if (!outcome.ok) return outcome;
    const deletionId = result.response.headers.get('Library-Collection-Member-Deletion-Id');
    const revision = Number(result.response.headers.get('Library-Collection-Member-Deletion-Revision'));
    return deletionId && uuid.test(deletionId) && Number.isSafeInteger(revision) && revision > 0
      ? {
          ...outcome,
          revision,
          undo: { collectionId: input.collectionId, memberId: input.memberId, deletionId, revision },
        }
      : outcome;
  } catch (error) {
    return refused(error);
  }
}

export async function removeCollectionMemberRecord(
  ...args: Parameters<typeof removeCollectionMemberWithUndoRecord>
): Promise<CollectionWriteResult> {
  const result = await removeCollectionMemberWithUndoRecord(...args);
  return result.ok ? { ok: true, id: result.id } : result;
}

export async function restoreCollectionMemberRecord(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: CollectionMemberUndo & { idempotencyKey: string },
): Promise<CollectionWriteResult> {
  if (
    !input.collectionId ||
    !input.memberId ||
    !uuid.test(input.deletionId) ||
    !Number.isSafeInteger(input.revision) ||
    input.revision < 1 ||
    !uuid.test(input.idempotencyKey)
  )
    return { ok: false, reason: 'invalid' };
  const session = await writeSession(request, sessionEnv);
  if (!asSession(session)) return session;
  try {
    const result = await client
      .collections({ collectionId: input.collectionId })
      .members({ memberId: input.memberId })
      .$restore.post(
        { deletionId: input.deletionId, revision: input.revision },
        { headers: kernelHeaders(session.authorization, input.idempotencyKey) },
      );
    return fromKernel(result, input.memberId);
  } catch (error) {
    return refused(error);
  }
}

/** One follow read with the viewer's credential. A follow that was never made is not an error. */
export async function readCollectionFollow(
  client: KernelClient,
  collectionId: string,
  authorization: string,
): Promise<boolean | null> {
  try {
    const result = await client.follows({ targetId: collectionId }).get({
      query: { view: 'FULL' },
      headers: { authorization },
    });
    const status = typeof result.status === 'number' ? result.status : result.error?.status;
    if (status === 404) return false;
    if (result.error || !result.data?.follow || !['following', 'unfollowed'].includes(result.data.follow.state))
      return null;
    return result.data.follow.state === 'following';
  } catch {
    return null;
  }
}

export async function followCollectionRecord(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: { collectionId: string; idempotencyKey: string },
): Promise<CollectionWriteResult> {
  if (!input.collectionId || !uuid.test(input.idempotencyKey)) return { ok: false, reason: 'invalid' };
  const session = await writeSession(request, sessionEnv);
  if (!asSession(session)) return session;
  try {
    const result = await client
      .follows({ targetId: input.collectionId })
      .put(null, { headers: kernelHeaders(session.authorization, input.idempotencyKey) });
    return fromKernel(result, input.collectionId);
  } catch (error) {
    return refused(error);
  }
}

export async function unfollowCollectionRecord(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: { collectionId: string; idempotencyKey: string },
): Promise<CollectionWriteResult> {
  if (!input.collectionId || !uuid.test(input.idempotencyKey)) return { ok: false, reason: 'invalid' };
  const session = await writeSession(request, sessionEnv);
  if (!asSession(session)) return session;
  try {
    const result = await client
      .follows({ targetId: input.collectionId })
      .delete(undefined, { headers: kernelHeaders(session.authorization, input.idempotencyKey) });
    return fromKernel(result, input.collectionId);
  } catch (error) {
    return refused(error);
  }
}
