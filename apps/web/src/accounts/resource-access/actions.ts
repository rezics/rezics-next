import { parseOwnerTransfer, transferOwner, type TransferResult } from './owner-transfer';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../../kernel/client';
import type { SessionEnv } from '../../session/client';
import { prepareSession, viewerCredential } from '../../session/request';
import { loadAccess, lookupIdentity, parseChange, routedId, writeAccess, type AccessState } from './data';

async function viewer() {
  setResponseHeader('cache-control', 'private, no-store');
  const request = getRequest();
  await prepareSession(request, env as Partial<SessionEnv>);
  return viewerCredential(request);
}

export const readResourceAccess = createServerFn({ method: 'GET' })
  .validator((input: { resourceId: string; cursor?: string }) => {
    if (
      !routedId(input.resourceId) ||
      (input.cursor !== undefined && (typeof input.cursor !== 'string' || input.cursor.length > 4096))
    )
      throw new Error('Invalid resource access request');
    return input;
  })
  .handler(async ({ data }): Promise<AccessState> => {
    try {
      const authorization = await viewer();
      return authorization
        ? await loadAccess(kernelClient(), authorization, data.resourceId, data.cursor)
        : { status: 'denied' };
    } catch {
      return { status: 'unavailable' };
    }
  });

export const saveResourceAccess = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const change = parseChange(input);
    if (!change) throw new Error('Invalid resource access change');
    return change;
  })
  .handler(async ({ data }) => {
    const authorization = await viewer();
    return authorization ? writeAccess(kernelClient(), authorization, data) : { status: 'denied' as const };
  });

export const findAccessIdentity = createServerFn({ method: 'GET' })
  .validator((input: { resourceId: string; handle: string }) => {
    if (!routedId(input.resourceId) || typeof input.handle !== 'string' || input.handle.length > 64)
      throw new Error('Invalid handle lookup');
    return input;
  })
  .handler(async ({ data }) => {
    const authorization = await viewer();
    if (!authorization) return null;
    const client = kernelClient();
    const current = await loadAccess(client, authorization, data.resourceId);
    return current.status === 'ready' ? lookupIdentity(client, authorization, data.handle) : null;
  });

export const transferResourceOwner = createServerFn({ method: 'POST' })
  .validator(parseOwnerTransfer)
  .handler(async ({ data }): Promise<TransferResult> => {
    const authorization = await viewer();
    if (!authorization) return { status: 'denied', current: { status: 'denied' } };
    const client = kernelClient();
    return transferOwner((env as { KERNEL_ORIGIN?: string }).KERNEL_ORIGIN, authorization, data, (session) =>
      loadAccess(client, authorization, data.resource.id, undefined, session),
    );
  });
