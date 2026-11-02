import { queryOptions } from '@tanstack/react-query';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import type { KernelClient } from '@rezics/client';
import { personalRead } from '../kernel/query';
import { MediaProblem } from '../media/kernel';
import type { SessionEnv } from '../session/client';
import { prepareSession, viewerCredential } from '../session/request';
import { nativeContinueSource } from './continue-adapter';
import { continueAddress } from './continue-address';
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
  .validator((input: { cursor?: unknown }) => continueAddress(input))
  .handler(async ({ data }) => {
    setResponseHeader('Cache-Control', 'private, no-store');
    if (data.malformed) return { state: 'unavailable', reason: 'invalid-address' } as const;
    const { env } = await import('cloudflare:workers');
    const { kernelClient } = await import('../kernel/client');
    return loadContinueState(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
  });

/** Shared private result for Library and its reachable Continue destination. */
export function readContinueEntries(input: { data: { cursor?: unknown } } = { data: {} }) {
  return readLibraryContinuePage(input);
}

export function libraryContinueQuery(locale: string, cursor?: string) {
  return queryOptions({
    ...personalRead,
    queryKey: ['library-continue', locale, cursor ?? ''],
    queryFn: () => readLibraryContinuePage({ data: { cursor } }),
    retry: false,
    refetchOnWindowFocus: false,
  });
}

/** Serializes readiness/failure separately from successful empty for every private page caller. */
export async function loadContinueState(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: { cursor?: unknown } = {},
  source: ContinueSource = nativeContinueSource,
): Promise<ContinueResult> {
  const address = continueAddress(input);
  if (address.malformed) return { state: 'unavailable', reason: 'invalid-address' };
  try {
    if (await prepareSession(request, sessionEnv, { refresh: false })) return { state: 'signed-out' };
    const authorization = viewerCredential(request);
    if (!authorization) return { state: 'signed-out' };
    const result = await source(client, authorization, { limit: CONTINUE_LIMIT, ...address }, request.signal);
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
