import type { KernelClient } from '@rezics/client';
import { queryOptions } from '@tanstack/react-query';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { isPlatformClosedError } from '../kernel/platform-closed';
import { personalRead } from '../kernel/query';
import { requestLocale } from '../kernel/client';
import { MediaProblem } from '../media/kernel';
import type { SessionEnv } from '../session/client';
import { prepareSession, requestCsrfToken, sessionSubject, viewerCredential } from '../session/request';

type TargetRead = NonNullable<Awaited<ReturnType<ReturnType<ReturnType<KernelClient['followCounts']>>['get']>>['data']>;
export type FollowCountTarget = Pick<TargetRead, 'targetType' | 'targetId'>;
export type FollowCountsSearch = Partial<FollowCountTarget> & { invalidContext?: true };
export type FollowCountState =
  | { state: 'ready'; count: number }
  | { state: 'loading' }
  | { state: 'denied' | 'closed' | 'signed-out' | 'unavailable'; status?: number; code?: string; retryAfter?: string };
export type FollowCountsRead = {
  context: FollowCountsSearch;
  outgoing: FollowCountState;
  target: FollowCountState | null;
};
export type FollowCountsViewer = { subject: string; csrfToken: string | null };
export type FollowCountsPage = FollowCountsRead & { viewer: FollowCountsViewer | null; locale?: string };
export type FollowCountsReader = (input: { data: FollowCountsSearch }) => Promise<FollowCountsPage>;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A single current resource query is context, never a grant or an account selector. */
export function followCountsSearch(input: unknown): FollowCountsSearch {
  if (!record(input) || Object.keys(input).some((key) => key !== 'targetType' && key !== 'targetId'))
    return { invalidContext: true };
  if (input.targetType === undefined && input.targetId === undefined) return {};
  if (
    typeof input.targetType !== 'string' ||
    !['subject', 'collection', 'space'].includes(input.targetType) ||
    typeof input.targetId !== 'string' ||
    !uuid.test(input.targetId)
  )
    return { invalidContext: true };
  return { targetType: input.targetType as FollowCountTarget['targetType'], targetId: input.targetId };
}

function failure(status?: number, body?: unknown, retryAfter?: string | null): FollowCountState {
  const code = record(body) && typeof body.code === 'string' ? body.code : undefined;
  const state =
    status === 401
      ? 'signed-out'
      : status === 403 && code === 'platform_closed'
        ? 'closed'
        : status === 403 || status === 404
          ? 'denied'
          : 'unavailable';
  return {
    state,
    ...(status === undefined ? {} : { status }),
    ...(code ? { code } : {}),
    ...(retryAfter ? { retryAfter } : {}),
  };
}

type NativeResult = { status: number; data: unknown; error: unknown; response: Response };
async function readCount(read: () => Promise<NativeResult>, target?: FollowCountTarget): Promise<FollowCountState> {
  try {
    const result = await read();
    if (result.status !== 200 || result.error) {
      const failed = failure(
        result.status,
        record(result.error) ? result.error.value : undefined,
        result.response.headers.get('retry-after'),
      );
      // Outgoing has no resource to conceal: 404 means this runtime cannot serve the delivered route.
      return result.status === 404 && !target ? { ...failed, state: 'unavailable' } : failed;
    }
    const body = result.data;
    const field = target ? 'followerCount' : 'followingCount';
    if (
      !record(body) ||
      Object.keys(body).length !== (target ? 3 : 1) ||
      (target && (body.targetType !== target.targetType || body.targetId !== target.targetId)) ||
      typeof body[field] !== 'number' ||
      !Number.isSafeInteger(body[field]) ||
      body[field] < 0
    )
      return { state: 'unavailable' };
    return { state: 'ready', count: body[field] };
  } catch (error) {
    if (isPlatformClosedError(error)) return failure(error.status, error.problem);
    return { state: 'unavailable' };
  }
}

/** One own GET and at most one contextual GET. Native follow_count.target alone decides management authority. */
export async function readFollowCounts(
  client: KernelClient,
  authorization: string,
  input: FollowCountsSearch,
): Promise<FollowCountsRead> {
  const context = followCountsSearch(input);
  const target =
    context.targetType && context.targetId ? { targetType: context.targetType, targetId: context.targetId } : undefined;
  const options = { headers: { authorization }, fetch: { cache: 'no-store' as const, redirect: 'manual' as const } };
  const [outgoing, targetCount] = await Promise.all([
    readCount(() => client.followCounts.outgoing.get(options)),
    target
      ? readCount(
          () => client.followCounts({ targetType: target.targetType })({ targetId: target.targetId }).get(options),
          target,
        )
      : null,
  ]);
  return { context, outgoing, target: targetCount };
}

export async function loadPrivateFollowCounts(
  client: KernelClient | null,
  request: Request,
  env: Partial<SessionEnv>,
  input: FollowCountsSearch,
): Promise<FollowCountsPage> {
  const context = followCountsSearch(input);
  let viewer: FollowCountsViewer | null = null;
  const locale = requestLocale(request) ?? 'en';
  try {
    if (await prepareSession(request, env))
      return { locale, viewer, context, outgoing: { state: 'signed-out' }, target: null };
    const authorization = viewerCredential(request);
    const subject = sessionSubject(request);
    const csrfToken = requestCsrfToken(request);
    if (!authorization || !subject)
      return { locale, viewer, context, outgoing: { state: 'signed-out' }, target: null };
    viewer = { subject, csrfToken };
    if (client) return { locale, viewer, ...(await readFollowCounts(client, authorization, context)) };
  } catch (error) {
    if (error instanceof MediaProblem)
      return {
        locale,
        viewer,
        context,
        outgoing: failure(error.problem.status, error.problem, new Headers(error.headers).get('retry-after')),
        target: null,
      };
  }
  return { locale, viewer, context, outgoing: { state: 'unavailable' }, target: null };
}

export const readPrivateFollowCountsPage = createServerFn({ method: 'GET' })
  .validator(followCountsSearch)
  .handler(async ({ data }): Promise<FollowCountsPage> => {
    setResponseHeader('cache-control', 'private, no-store');
    const { env } = await import('cloudflare:workers');
    const { kernelClient } = await import('../kernel/client');
    // An unconfigured runtime must never use development recordings as private count truth.
    const client = (env as { KERNEL_ORIGIN?: string }).KERNEL_ORIGIN ? kernelClient() : null;
    const page = await loadPrivateFollowCounts(client, getRequest(), env as Partial<SessionEnv>, data);
    const retryAfter = [page.outgoing, page.target].find((state) => state && 'retryAfter' in state && state.retryAfter);
    if (retryAfter && 'retryAfter' in retryAfter && retryAfter.retryAfter)
      setResponseHeader('retry-after', retryAfter.retryAfter);
    return page;
  });

/** Browser-only read, optionally partitioned by mounted admission; no retries, polling or stale account fallback. */
export function privateFollowCountsQuery(
  viewer: FollowCountsViewer,
  input: FollowCountsSearch,
  read: FollowCountsReader = readPrivateFollowCountsPage,
  lifetime?: { key: string; isCurrent: () => boolean; locale?: string },
) {
  const context = followCountsSearch(input);
  const retired: FollowCountsPage = {
    viewer: null,
    context,
    outgoing: { state: 'unavailable' },
    target: null,
    ...(lifetime?.locale ? { locale: lifetime.locale } : {}),
  };
  return queryOptions({
    ...personalRead,
    queryKey: [
      'library-private-follow-counts',
      viewer.subject,
      context.targetType ?? '',
      context.targetId ?? '',
      !!context.invalidContext,
      ...(lifetime ? [lifetime.key] : []),
    ],
    queryFn: async ({ signal }): Promise<FollowCountsPage> => {
      signal.throwIfAborted();
      if (!viewer.subject.trim() || (lifetime && !lifetime.isCurrent())) return retired;
      const page = await read({ data: context });
      signal.throwIfAborted();
      if (lifetime && !lifetime.isCurrent()) return retired;
      const actualContext = followCountsSearch(page.context);
      if (
        (lifetime?.locale !== undefined && page.locale !== lifetime.locale) ||
        page.viewer?.subject !== viewer.subject ||
        actualContext.targetType !== context.targetType ||
        actualContext.targetId !== context.targetId ||
        !!actualContext.invalidContext !== !!context.invalidContext
      )
        return {
          viewer: null,
          context,
          ...(lifetime?.locale ? { locale: lifetime.locale } : {}),
          outgoing: page.viewer === null && page.outgoing.state !== 'ready' ? page.outgoing : { state: 'unavailable' },
          target: null,
        };
      return page;
    },
    gcTime: 0,
    staleTime: Infinity,
    retry: false,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}
