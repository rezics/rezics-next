import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import { prepareSession, viewerCredential } from '../session/request';
import { readRealmJoinAdvice as readInstalledRealmJoinAdvice } from './native-operations';
import { loadRealmMembership } from './space';

export const readRealmMembership = createServerFn({ method: 'GET' })
  .validator((input: unknown) => {
    if (
      !input ||
      typeof input !== 'object' ||
      !('realmId' in input) ||
      typeof input.realmId !== 'string' ||
      !input.realmId ||
      input.realmId.length > 128
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

export const readRealmJoinAdvice = createServerFn({ method: 'GET' })
  .validator((input: unknown) => {
    if (
      !input ||
      typeof input !== 'object' ||
      !('realmId' in input) ||
      typeof input.realmId !== 'string' ||
      !input.realmId ||
      input.realmId.length > 128
    )
      throw new Error('Invalid Realm join advice request');
    return { realmId: input.realmId };
  })
  .handler(async ({ data }) => {
    setResponseHeader('Cache-Control', 'private, no-store');
    try {
      const request = getRequest();
      await prepareSession(request, env as Partial<SessionEnv>, { refresh: false });
      const authorization = viewerCredential(request);
      if (!authorization) return { state: 'refused' } as const;
      return await readInstalledRealmJoinAdvice(kernelClient(), data.realmId, authorization);
    } catch (error) {
      const status =
        error && typeof error === 'object' && 'status' in error && typeof error.status === 'number'
          ? error.status
          : undefined;
      return status === 401 || status === 403 ? { state: 'refused' } : { state: 'unavailable' };
    }
  });
