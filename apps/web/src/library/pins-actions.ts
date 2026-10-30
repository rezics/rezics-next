import type { KernelClient } from '@rezics/client';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import { prepareSession, viewerCredential } from '../session/request';

type WriteResult = {
  status?: number;
  error?: { status?: number; value?: unknown } | null;
  data?: { revision: number } | null;
};

type LibraryPinsApi = {
  libraryPins: (params: { collectionId: string }) => {
    put(
      body: { revision: number; after?: string | null },
      options: { headers: { authorization: string; 'idempotency-key': string } },
    ): Promise<WriteResult>;
    delete(
      body: undefined,
      options: {
        query: { revision: number };
        headers: { authorization: string; 'idempotency-key': string };
      },
    ): Promise<WriteResult>;
  };
};

function pinApi(client: KernelClient): LibraryPinsApi {
  // The pin routes are waiting for the generated client update from commerce's library-pins runtime.
  return client as unknown as LibraryPinsApi;
}

export type PinMutation =
  | { ok: true; revision: number }
  | { ok: false; reason: 'conflict' | 'full' | 'closed' | 'unavailable' | 'signed-out' };

function statusOf(result: WriteResult): number | undefined {
  return result.status ?? result.error?.status;
}

function codeOf(error: WriteResult['error']): string | undefined {
  const value = error?.value;
  if (!value || typeof value !== 'object' || !('code' in value) || typeof value.code !== 'string') return undefined;
  return value.code;
}

function headers(authorization: string, idempotencyKey: string) {
  // The pin endpoints are waiting for the generated client's header declaration from commerce.
  return { authorization, 'idempotency-key': idempotencyKey } as {
    authorization: string;
    'idempotency-key': string;
  };
}

/** Sends one revision-guarded pin placement with its structured idempotency key. */
export async function putLibraryPin(
  client: KernelClient,
  authorization: string,
  collectionId: string,
  revision: number,
  after: string | null | undefined,
  idempotencyKey: string,
): Promise<PinMutation> {
  try {
    const result = await pinApi(client)
      .libraryPins({ collectionId })
      .put(
        { revision, ...(after === undefined ? {} : { after }) },
        { headers: headers(authorization, idempotencyKey) },
      );
    const status = statusOf(result);
    if (status === 409) return { ok: false, reason: codeOf(result.error) === 'collection_full' ? 'full' : 'conflict' };
    if (result.error || (status !== undefined && status >= 400) || !result.data)
      return { ok: false, reason: 'unavailable' };
    return { ok: true, revision: result.data.revision };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}

/** Removes one pin using the revision read for the current page. */
export async function deleteLibraryPin(
  client: KernelClient,
  authorization: string,
  collectionId: string,
  revision: number,
  idempotencyKey: string,
): Promise<PinMutation> {
  try {
    const result = await pinApi(client)
      .libraryPins({ collectionId })
      .delete(undefined, {
        query: { revision },
        headers: headers(authorization, idempotencyKey),
      });
    const status = statusOf(result);
    if (status === 409) return { ok: false, reason: 'conflict' };
    if (result.error || (status !== undefined && status >= 400)) return { ok: false, reason: 'unavailable' };
    return { ok: true, revision: result.data?.revision ?? revision };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}

function validateInput(input: unknown): {
  collectionId: string;
  revision: number;
  after?: string | null;
  idempotencyKey: string;
} {
  if (
    !input ||
    typeof input !== 'object' ||
    !('collectionId' in input) ||
    typeof input.collectionId !== 'string' ||
    input.collectionId.length === 0 ||
    input.collectionId.length > 128 ||
    !('revision' in input) ||
    typeof input.revision !== 'number' ||
    !Number.isSafeInteger(input.revision) ||
    input.revision < 0 ||
    ('after' in input && input.after !== undefined && input.after !== null && typeof input.after !== 'string') ||
    !('idempotencyKey' in input) ||
    typeof input.idempotencyKey !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.idempotencyKey)
  )
    throw new Error('Invalid pin request');
  return {
    collectionId: input.collectionId,
    revision: input.revision,
    ...('after' in input && input.after !== undefined ? { after: input.after as string | null } : {}),
    idempotencyKey: input.idempotencyKey,
  };
}

async function submit(action: 'put' | 'delete', data: ReturnType<typeof validateInput>): Promise<PinMutation> {
  const request = getRequest();
  await prepareSession(request, env as Partial<SessionEnv>);
  const authorization = viewerCredential(request);
  if (!authorization) return { ok: false, reason: 'signed-out' };
  const client = kernelClient();
  const result =
    action === 'put'
      ? await putLibraryPin(client, authorization, data.collectionId, data.revision, data.after, data.idempotencyKey)
      : await deleteLibraryPin(client, authorization, data.collectionId, data.revision, data.idempotencyKey);
  return result;
}

export const pinCollection = createServerFn({ method: 'POST' })
  .validator(validateInput)
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    return submit('put', data);
  });

export const unpinCollection = createServerFn({ method: 'POST' })
  .validator(validateInput)
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    return submit('delete', data);
  });
