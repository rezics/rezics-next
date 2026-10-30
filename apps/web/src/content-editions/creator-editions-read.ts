import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import type { SessionEnv } from '../session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../session/request';
import { recordPageReadCacheControl } from '../security/page-cache';
import {
  createNativeCreatorEditionsApi,
  creatorEditionsSearch,
  loadCreatorEditions,
  type CreatorEditionsApi,
  type CreatorEditionsPage,
  type CreatorEditionsSearch,
} from './creator-editions';

export async function loadSessionCreatorEditions(
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  api: CreatorEditionsApi,
  search: CreatorEditionsSearch,
): Promise<CreatorEditionsPage> {
  try {
    if (await prepareSession(request, sessionEnv)) return { kind: 'sign-in' };
    const accountId = sessionSubject(request);
    const authorization = viewerCredential(request);
    if (!accountId || !authorization) return { kind: 'sign-in' };
    return await loadCreatorEditions(api, accountId, authorization, search);
  } catch {
    return { kind: 'unavailable' };
  }
}

export const readCreatorEditions = createServerFn({ method: 'GET' })
  .validator((value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid editions request');
    return creatorEditionsSearch('cursor' in value ? { cursor: value.cursor } : {});
  })
  .handler(async ({ data }): Promise<CreatorEditionsPage> => {
    const request = getRequest();
    setResponseHeader('cache-control', 'private, no-store');
    setResponseHeader('x-robots-tag', 'noindex, nofollow');
    recordPageReadCacheControl(request, 'private, no-store');
    const origin = (env as { KERNEL_ORIGIN?: string }).KERNEL_ORIGIN;
    return loadSessionCreatorEditions(
      request,
      env as Partial<SessionEnv>,
      createNativeCreatorEditionsApi(origin),
      data,
    );
  });
