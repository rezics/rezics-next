import { queryOptions } from '@tanstack/react-query';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import type { KernelClient } from '@rezics/client';
import { personalRead } from '../kernel/query';
import { MediaProblem } from '../media/kernel';
import type { SessionEnv } from '../session/client';
import { prepareSession, viewerCredential } from '../session/request';
import { nativeContinueSource } from './continue-adapter';
import {
  CONTINUE_LIMIT,
  ContinueReadError,
  continueFailure,
  type ContinueEntry,
  type ContinueResult,
  type ContinueSource,
} from './continue-source';

export { CONTINUE_LIMIT, ContinueReadError, continueProgress } from './continue-source';
export type { ContinueEntry, ContinueProgress, ContinueResult, ContinueView } from './continue-source';

export function homeContinueQuery<T>(locale: string, read: () => Promise<T>) {
  return queryOptions({
    ...personalRead,
    queryKey: ['home-continue', locale],
    queryFn: read,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

const readLibraryContinuePage = createServerFn({ method: 'GET' })
  .validator((input: { cursor?: string }) => ({ ...(input.cursor ? { cursor: input.cursor } : {}) }))
  .handler(async ({ data }) => {
    const { env } = await import('cloudflare:workers');
    const { kernelClient } = await import('../kernel/client');
    setResponseHeader('Cache-Control', 'private, no-store');
    return loadContinueState(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
  });

/** Shared private result for Library and its reachable Continue destination. */
export function readContinueEntries(input: { data: { cursor?: string } } = { data: {} }) {
  return readLibraryContinuePage(input);
}

export function libraryContinueQuery(locale: string, cursor?: string) {
  return queryOptions({
    ...personalRead,
    queryKey: ['library-continue', locale, cursor ?? ''],
    queryFn: () => readLibraryContinuePage({ data: { ...(cursor ? { cursor } : {}) } }),
    retry: false,
    refetchOnWindowFocus: false,
  });
}

/** Serializes readiness/failure separately from successful empty for every private page caller. */
export async function loadContinueState(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: { cursor?: string } = {},
  source: ContinueSource = nativeContinueSource,
): Promise<ContinueResult> {
  try {
    await prepareSession(request, sessionEnv, { refresh: false });
    const authorization = viewerCredential(request);
    if (!authorization) return { state: 'signed-out' };
    const result = await source(client, authorization, { limit: CONTINUE_LIMIT, ...input }, request.signal);
    return result.state === 'loaded' ? { ...result, entries: result.entries.slice(0, CONTINUE_LIMIT) } : result;
  } catch (error) {
    if (error instanceof ContinueReadError) return error.failure;
    if (error instanceof MediaProblem)
      return continueFailure(error.problem.status, new Headers(error.headers).get('retry-after'));
    return { state: 'unavailable' };
  }
}

/** Retain the array API for existing consumers; failure can never masquerade as successful empty input. */
export async function loadContinue(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
): Promise<ContinueEntry[]> {
  const result = await loadContinueState(client, request, sessionEnv);
  if (result.state === 'signed-out') return [];
  if (result.state !== 'loaded') throw new ContinueReadError(result);
  return result.entries;
}
