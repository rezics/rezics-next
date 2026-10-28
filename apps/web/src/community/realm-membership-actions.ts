import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import { prepareSession, viewerCredential } from '../session/request';
import { loadRealmMembership } from './space';

export const readRealmMembership = createServerFn({ method: 'GET' })
  .validator((input: unknown) => {
    if (
      !input ||
      typeof input !== 'object' ||
      !('realmId' in input) ||
      typeof input.realmId !== 'string' ||
      !input.realmId
    )
      throw new Error('Invalid Realm membership request');
    return { realmId: input.realmId };
  })
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    await prepareSession(request, env as Partial<SessionEnv>);
    const authorization = viewerCredential(request);
    if (!authorization) return null;
    return loadRealmMembership(kernelClient(), data.realmId, { headers: { authorization } });
  });
