import type { KernelClient } from '@rezics/client';
import { MediaProblem } from '../media/kernel';
import { isPlatformClosedError, isPlatformClosedProblem, PlatformClosedError } from '../kernel/platform-closed';
import type { SessionEnv } from '../session/client';
import { prepareSession, viewerCredential } from '../session/request';
import type { CollectionVisibility } from './reads';

export type CollectionWriteResult =
  | { ok: true; id: string }
  | { ok: false; reason: 'closed' | 'conflict' | 'forbidden' | 'full' | 'invalid' | 'unauthorized' | 'unavailable' };

type LibraryFailure = {
  data?: unknown;
  error?: { status?: number; value?: unknown } | null;
  status?: number;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function kernelHeaders(authorization: string, idempotencyKey: string): { 'idempotency-key': string } {
  return { authorization, 'idempotency-key': idempotencyKey } as { 'idempotency-key': string };
}

/**
 * One session read. A write stops here when the cookie, origin or `X-CSRF-Token` header does not match; the token is
 * accepted from the header only.
 */
async function writeSession(
  request: Request,
  sessionEnv: Partial<SessionEnv>,
): Promise<{ authorization: string } | CollectionWriteResult> {
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

function refused(error: unknown): CollectionWriteResult {
  if (isPlatformClosedError(error)) return { ok: false, reason: 'closed' };
  return { ok: false, reason: 'unavailable' };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function problemCode(body: unknown): string {
  return isRecord(body) && typeof body.code === 'string' ? body.code : '';
}

function fromKernel(result: LibraryFailure, id: string): CollectionWriteResult {
  const status = typeof result.status === 'number' ? result.status : result.error?.status;
  const body = result.error?.value;
  if (isPlatformClosedProblem(status, body)) throw new PlatformClosedError(status ?? 403, body);
  const code = problemCode(body);
  if (code === 'collection_full') return { ok: false, reason: 'full' };
  const succeeded = status === 204 || (!result.error && status !== undefined && status < 400);
  if (succeeded) return id.length > 0 ? { ok: true, id } : { ok: false, reason: 'unavailable' };
  if (code === 'conflict' || status === 409) return { ok: false, reason: 'conflict' };
  if (status === 401 || status === 403) return { ok: false, reason: 'forbidden' };
  if (status === 400 || status === 404 || status === 422) return { ok: false, reason: 'invalid' };
  return { ok: false, reason: 'unavailable' };
}

function asSession(value: { authorization: string } | CollectionWriteResult): value is { authorization: string } {
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
  input: { title: string; description: string; visibility: string; idempotencyKey: string },
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
  },
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
      },
      { headers: kernelHeaders(session.authorization, input.idempotencyKey) },
    );
    return fromKernel(result, input.collectionId);
  } catch (error) {
    return refused(error);
  }
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
    // A 204 whose JSON body was dropped still means the delete was applied.
    if (error instanceof SyntaxError) return { ok: true, id: input.collectionId };
    return refused(error);
  }
}

export async function moveCollectionMemberRecord(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: { collectionId: string; memberId: string; after: string | null; idempotencyKey: string },
): Promise<CollectionWriteResult> {
  if (!input.collectionId || !input.memberId || !uuid.test(input.idempotencyKey)) {
    return { ok: false, reason: 'invalid' };
  }
  if (input.after !== null && input.after.length === 0) return { ok: false, reason: 'invalid' };
  const session = await writeSession(request, sessionEnv);
  if (!asSession(session)) return session;
  try {
    const result = await client
      .collections({ collectionId: input.collectionId })
      .members({ memberId: input.memberId })
      .$move.post({ after: input.after }, { headers: kernelHeaders(session.authorization, input.idempotencyKey) });
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

export async function removeCollectionMemberRecord(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: { collectionId: string; memberId: string; idempotencyKey: string },
): Promise<CollectionWriteResult> {
  if (!input.collectionId || !input.memberId || !uuid.test(input.idempotencyKey)) {
    return { ok: false, reason: 'invalid' };
  }
  const session = await writeSession(request, sessionEnv);
  if (!asSession(session)) return session;
  try {
    const result = await client
      .collections({ collectionId: input.collectionId })
      .members({ memberId: input.memberId })
      .delete(undefined, { headers: kernelHeaders(session.authorization, input.idempotencyKey) });
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
    if (result.error) return null;
    const follow = isRecord(result.data) ? result.data.follow : undefined;
    return isRecord(follow) && follow.state === 'following';
  } catch {
    // A closed or failing follow read hides the button without hiding the collection.
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
