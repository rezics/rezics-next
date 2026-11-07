import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import type { KernelClient } from '@rezics/client';
import type { SessionEnv } from '../../session/client';
import { asSession, isRecord, kernelHeaders, writeSession } from '../collection-records';
import { isPlatformClosedProblem } from '../../session/reading-policy';

export type QueryPublicationInput = {
  collectionId: string;
  revision: number;
  visibility: 'public' | 'unlisted';
  idempotencyKey: string;
};
export type QueryPublicationStatus = {
  id: string;
  collectionId: string;
  visibility: 'public' | 'unlisted';
} & (
  | { phase: 'staging' | 'awaiting_activation' | 'refused' }
  | { phase: 'complete'; publication: { generation: string } }
);
export type QueryPublicationResult =
  | { ok: true; status: QueryPublicationStatus }
  | { ok: false; reason: 'denied' | 'stale' | 'unavailable' | 'unknown' | 'closed' };

const uuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

/** Server-function and retained browser-file boundary. The page never supplies a subset or rule. */
export function queryPublicationInput(value: unknown): QueryPublicationInput {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 4 ||
    !uuid(value.collectionId) ||
    typeof value.revision !== 'number' ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    (value.visibility !== 'public' && value.visibility !== 'unlisted') ||
    !uuid(value.idempotencyKey)
  )
    throw new Error('Invalid whole-query publication request');
  return {
    collectionId: value.collectionId,
    revision: value.revision,
    visibility: value.visibility,
    idempotencyKey: value.idempotencyKey,
  };
}

export function queryPublicationAddress(value: unknown): { collectionId: string; id: string } {
  if (!isRecord(value) || !uuid(value.collectionId) || !uuid(value.id))
    throw new Error('Invalid whole-query publication address');
  return { collectionId: value.collectionId, id: value.id };
}

/** Decode only a native response; pending output is never promoted to complete by the page. */
export function queryPublicationResponse(code: number, body: unknown, collectionId: string): QueryPublicationResult {
  if (isPlatformClosedProblem(code, body)) return { ok: false, reason: 'closed' };
  if (code === 409) return { ok: false, reason: 'stale' };
  if ([400, 401, 403, 404, 422].includes(code)) return { ok: false, reason: 'denied' };
  if (code !== 200 && code !== 202) return { ok: false, reason: 'unknown' };
  if (
    !isRecord(body) ||
    !uuid(body.id) ||
    body.collectionId !== collectionId ||
    (body.visibility !== 'public' && body.visibility !== 'unlisted')
  )
    return { ok: false, reason: 'unknown' };
  const common: Pick<QueryPublicationStatus, 'id' | 'collectionId' | 'visibility'> = {
    id: body.id,
    collectionId,
    visibility: body.visibility,
  };
  if (body.phase === 'complete' && isRecord(body.publication) && uuid(body.publication.generation))
    return {
      ok: true,
      status: { ...common, phase: 'complete', publication: { generation: body.publication.generation } },
    };
  if (body.phase === 'staging' || body.phase === 'awaiting_activation' || body.phase === 'refused')
    return { ok: true, status: { ...common, phase: body.phase } };
  return { ok: false, reason: 'unknown' };
}

/** Use the installed mounted binding and return a plain serializable feature value. */
export async function publishQueryNative(
  client: KernelClient,
  request: Request,
  env: Partial<SessionEnv>,
  input: QueryPublicationInput,
): Promise<QueryPublicationResult> {
  const session = await writeSession(request, env);
  if (!asSession(session)) return { ok: false, reason: 'denied' };
  const result = await client
    .collections({ collectionId: input.collectionId })
    .$publish.post(
      { revision: input.revision, visibility: input.visibility },
      { headers: kernelHeaders(session.authorization, input.idempotencyKey) },
    );
  return queryPublicationResponse(result.status, result.data ?? result.error?.value, input.collectionId);
}

export async function readQueryPublicationNative(
  client: KernelClient,
  request: Request,
  env: Partial<SessionEnv>,
  input: { collectionId: string; id: string },
): Promise<QueryPublicationResult> {
  const session = await writeSession(request, env);
  if (!asSession(session)) return { ok: false, reason: 'denied' };
  const result = await client
    .collectionPublications({ id: input.id })
    .get({ headers: { authorization: session.authorization } });
  const value = queryPublicationResponse(result.status, result.data ?? result.error?.value, input.collectionId);
  return value.ok && value.status.id !== input.id ? { ok: false, reason: 'unknown' } : value;
}

export const publishQueryCollection = createServerFn({ method: 'POST' })
  .validator(queryPublicationInput)
  .handler(async ({ data }): Promise<QueryPublicationResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    const { env } = await import('cloudflare:workers');
    const { kernelClient } = await import('../../kernel/client');
    return publishQueryNative(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
  });

// POST protects the session read with the same supported CSRF profile as publication.
export const readQueryPublication = createServerFn({ method: 'POST' })
  .validator(queryPublicationAddress)
  .handler(async ({ data }): Promise<QueryPublicationResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    const { env } = await import('cloudflare:workers');
    const { kernelClient } = await import('../../kernel/client');
    return readQueryPublicationNative(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
  });
