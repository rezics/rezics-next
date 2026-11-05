import type { KernelClient } from '@rezics/client';

/** Consume the mounted operation.get DTO, including its native AIP-151 result arms. */
type NativeOperation = NonNullable<Awaited<ReturnType<ReturnType<KernelClient['operations']>['get']>>['data']>;
type NativeFailure = Extract<NativeOperation, { error: unknown }>;
// RPC details are deliberately absent from the browser's serializable subset.
export type ErasureOperation =
  | Exclude<NativeOperation, NativeFailure>
  | (Omit<NativeFailure, 'error'> & { error: Pick<NativeFailure['error'], 'code' | 'message'> });
export type ErasureIntent = Readonly<{ threadId: string; idempotencyKey: string }>;
export type ErasureIdentity = Readonly<{ authorization: string; subject: string }>;
export type ErasureFailure = 'signed-out' | 'forbidden' | 'not-found' | 'unavailable' | 'conflict';
export type ErasureEnqueue = { kind: 'accepted'; operationId: string } | { kind: ErasureFailure | 'uncertain' };
export type ErasureRead = { kind: 'available'; operation: ErasureOperation } | { kind: ErasureFailure };

export const validErasureId = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** Validate and allowlist: native error text/details, bodies and unknown fields never reach the browser. */
export function parseErasureOperation(value: unknown, expectedId?: string): ErasureOperation | null {
  if (!record(value) || typeof value.name !== 'string' || !value.name.startsWith('operations/')) return null;
  const id = value.name.slice('operations/'.length);
  if (!validErasureId(id) || (expectedId !== undefined && id !== expectedId)) return null;
  const meta = value.metadata;
  if (
    !record(meta) ||
    meta.type !== 'content.author_erasure' ||
    !validErasureId(meta.threadId) ||
    !validErasureId(meta.authorId) ||
    !count(meta.processedPosts) ||
    !count(meta.erasedRevisions) ||
    !count(meta.steps)
  )
    return null;
  const base = {
    name: `operations/${id}` as const,
    metadata: {
      type: 'content.author_erasure' as const,
      threadId: meta.threadId,
      authorId: meta.authorId,
      processedPosts: meta.processedPosts,
      erasedRevisions: meta.erasedRevisions,
      steps: meta.steps,
    },
  };
  if (value.done === false && value.response === undefined && value.error === undefined)
    return { ...base, done: false };
  if (value.done !== true) return null;
  if (
    value.error === undefined &&
    record(value.response) &&
    count(value.response.processedPosts) &&
    count(value.response.erasedRevisions)
  ) {
    return {
      ...base,
      done: true,
      response: { processedPosts: value.response.processedPosts, erasedRevisions: value.response.erasedRevisions },
    };
  }
  if (
    value.response === undefined &&
    record(value.error) &&
    Number.isInteger(value.error.code) &&
    (value.error.code as number) >= 1 &&
    (value.error.code as number) <= 16
  ) {
    return { ...base, done: true, error: { code: value.error.code as number, message: 'Author erasure failed' } };
  }
  return null;
}

function refusal(status: number): ErasureFailure {
  return status === 401 || status === 403
    ? 'forbidden'
    : status === 404
      ? 'not-found'
      : status === 409
        ? 'conflict'
        : 'unavailable';
}

/** The author selection comes only from the server session. Native post:erase remains the command authority. */
export async function enqueueAuthorErasure(
  client: KernelClient,
  identity: ErasureIdentity,
  intent: ErasureIntent,
): Promise<ErasureEnqueue> {
  try {
    const headers = { authorization: identity.authorization, 'idempotency-key': JSON.stringify(intent.idempotencyKey) };
    const result = await client
      .threads({ id: intent.threadId })
      .$erase.post({ authorId: identity.subject }, { headers });
    if (result.status === 202 && !result.error) {
      const operation = parseErasureOperation(result.data);
      if (operation?.metadata.threadId === intent.threadId && operation.metadata.authorId === identity.subject)
        return { kind: 'accepted', operationId: operation.name.slice('operations/'.length) };
      return { kind: 'uncertain' };
    }
    if (result.status >= 400 && result.status < 500) return { kind: refusal(result.status) };
    const body: unknown = result.error?.value;
    return record(body) && body.effect_status === 'not_applied' ? { kind: 'unavailable' } : { kind: 'uncertain' };
  } catch {
    return { kind: 'uncertain' };
  }
}

export async function readAuthorErasure(client: KernelClient, authorization: string, id: string): Promise<ErasureRead> {
  try {
    const result = await client.operations({ id }).get({ headers: { authorization, 'cache-control': 'no-store' } });
    if (result.error || result.status !== 200) return { kind: refusal(result.status) };
    const operation = parseErasureOperation(result.data, id);
    return operation ? { kind: 'available', operation } : { kind: 'unavailable' };
  } catch {
    return { kind: 'unavailable' };
  }
}

/** One immutable intent for all retries, including a response lost after native commit. */
export function authorErasureRequest(intent: ErasureIntent, send: (intent: ErasureIntent) => Promise<ErasureEnqueue>) {
  const original = Object.freeze({ ...intent });
  return () => send(original);
}

export function erasureStage(operation: ErasureOperation): 'queued' | 'running' | 'failed' | 'completed' {
  if (operation.done) return operation.error ? 'failed' : 'completed';
  const { processedPosts, erasedRevisions, steps } = operation.metadata;
  return processedPosts > 0 || erasedRevisions > 0 || steps > 0 ? 'running' : 'queued';
}

export const erasureRefreshLimit = 4;
export function authorErasureRefreshes(read: () => Promise<ErasureRead>) {
  let attempts = 0;
  return {
    remaining: () => erasureRefreshLimit - attempts,
    async foreground(visible: boolean): Promise<ErasureRead | null> {
      if (!visible || attempts >= erasureRefreshLimit) return null;
      attempts += 1;
      return read();
    },
  };
}
