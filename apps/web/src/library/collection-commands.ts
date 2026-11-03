import type { KernelClient } from '@rezics/client';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import { deleteCollection, updateCollection } from './collection-edit';
import { deleteCollectionRecord, updateCollectionRecord } from './collection-records';
import {
  asSession,
  fromKernel,
  kernelHeaders,
  refused,
  writeSession,
  type CollectionMemberUndo,
  type CollectionWriteResult,
} from './collection-records';

type Selection = { collectionId: string; revision: number; memberIds: string[]; idempotencyKey: string };
export type CollectionTransfer = Selection & {
  destinationCollectionId: string;
  destinationRevision: number;
  after: string | null;
};
type Failure = Extract<CollectionWriteResult, { ok: false }>;
export type CollectionBatchResult = Failure | { ok: true; revision: number; undo: CollectionMemberUndo[] };
export type CollectionTransferResult = Failure | { ok: true; revision: number; destinationRevision: number };

type CsrfHeaders = Readonly<{ 'X-CSRF-Token': string }>;
type CapturedRequest<Data> = Readonly<{ data: Readonly<Data>; headers: CsrfHeaders }>;

/** A retry keeps the original request object and sender for the full command lifetime. */
export type CapturedCollectionCommand<Data> = Readonly<{
  request: CapturedRequest<Data>;
  send: () => Promise<CollectionWriteResult>;
}>;

export function captureCollectionCommand<Data extends object>(
  data: Data,
  csrfToken: string,
  sender: (request: CapturedRequest<Data>) => Promise<CollectionWriteResult>,
): CapturedCollectionCommand<Data> {
  if (!csrfToken) throw new Error('Collection command credential unavailable');
  const request = Object.freeze({
    data: Object.freeze({ ...data }),
    headers: Object.freeze({ 'X-CSRF-Token': csrfToken }),
  });
  return Object.freeze({ request, send: () => sender(request) });
}

type CollectionUpdateData = Parameters<typeof updateCollectionRecord>[3];
type CollectionDeleteData = Parameters<typeof deleteCollectionRecord>[3];

/** Binds the installed metadata command; it does not create a second route or writer. */
export function captureCollectionUpdate(data: CollectionUpdateData, csrfToken: string) {
  return captureCollectionCommand(data, csrfToken, (request) =>
    updateCollection({ data: request.data, headers: request.headers }),
  );
}

/** Binds the installed revisioned delete command; a retry reuses its exact delete operands. */
export function captureCollectionDelete(data: CollectionDeleteData, csrfToken: string) {
  return captureCollectionCommand(data, csrfToken, (request) =>
    deleteCollection({ data: request.data, headers: request.headers }),
  );
}

const identifier = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 128;
const revision = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

export function collectionSelection(input: unknown): Selection {
  if (!input || typeof input !== 'object') throw new Error('Invalid Collection selection');
  const value = input as Record<string, unknown>;
  if (
    !identifier(value.collectionId) ||
    !revision(value.revision) ||
    typeof value.idempotencyKey !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.idempotencyKey) ||
    !Array.isArray(value.memberIds) ||
    value.memberIds.length < 1 ||
    value.memberIds.length > 100 ||
    !value.memberIds.every(identifier) ||
    new Set(value.memberIds).size !== value.memberIds.length
  )
    throw new Error('Invalid Collection selection');
  return {
    collectionId: value.collectionId,
    revision: value.revision,
    memberIds: [...value.memberIds],
    idempotencyKey: value.idempotencyKey,
  };
}

export function collectionTransfer(input: unknown): CollectionTransfer {
  const selection = collectionSelection(input);
  const value = input as Record<string, unknown>;
  if (
    !identifier(value.destinationCollectionId) ||
    value.destinationCollectionId === selection.collectionId ||
    !revision(value.destinationRevision) ||
    (value.after !== null && !identifier(value.after))
  )
    throw new Error('Invalid Collection destination');
  return {
    ...selection,
    destinationCollectionId: value.destinationCollectionId,
    destinationRevision: value.destinationRevision,
    after: value.after,
  };
}

/** One native atomic command; no membership writes or Undo episodes are synthesized in the BFF. */
export async function batchRemoveCollectionMembersRecord(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: Selection,
): Promise<CollectionBatchResult> {
  try {
    const { collectionId, idempotencyKey, ...body } = collectionSelection(input);
    const session = await writeSession(request, sessionEnv);
    if (!asSession(session)) return session;
    const result = await client.collections({ collectionId }).members.$batchRemove.post(body, {
      headers: kernelHeaders(session.authorization, idempotencyKey),
    });
    const outcome = fromKernel(result, collectionId);
    if (!outcome.ok) return outcome;
    if (!result.data) return { ok: false, reason: 'unavailable' };
    return {
      ok: true,
      revision: result.data.collection.revision,
      undo: result.data.removed.map((episode) => ({ collectionId, ...episode })),
    };
  } catch (error) {
    return refused(error);
  }
}

export async function transferCollectionMembersRecord(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: CollectionTransfer,
): Promise<CollectionTransferResult> {
  try {
    const { collectionId, idempotencyKey, ...body } = collectionTransfer(input);
    const session = await writeSession(request, sessionEnv);
    if (!asSession(session)) return session;
    const result = await client.collections({ collectionId }).members.$move.post(body, {
      headers: kernelHeaders(session.authorization, idempotencyKey),
    });
    const outcome = fromKernel(result, collectionId);
    if (!outcome.ok) return outcome;
    if (!result.data) return { ok: false, reason: 'unavailable' };
    return { ok: true, revision: result.data.source.revision, destinationRevision: result.data.destination.revision };
  } catch (error) {
    return refused(error);
  }
}

export const batchRemoveCollectionMembers = createServerFn({ method: 'POST' })
  .validator(collectionSelection)
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    return batchRemoveCollectionMembersRecord(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
  });

export const transferCollectionMembers = createServerFn({ method: 'POST' })
  .validator(collectionTransfer)
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    return transferCollectionMembersRecord(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
  });
