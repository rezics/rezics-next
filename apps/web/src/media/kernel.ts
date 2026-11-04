import { createKernelClient, type KernelClient } from '@rezics/client';
import { isPlatformClosedProblem } from '../kernel/platform-closed.ts';

type MediaRoutes = ReturnType<KernelClient['media']>;
type ReadResponse = Awaited<ReturnType<MediaRoutes['get']>>;
type CompletionCall = MediaRoutes['$complete']['post'];
type CompletionResponse = Awaited<ReturnType<CompletionCall>>;
type DownloadResponse = Awaited<ReturnType<MediaRoutes['$authorizeDownload']['get']>>;
export type Media = NonNullable<ReadResponse['data']>['media'];
export type DownloadDecision = NonNullable<DownloadResponse['data']>;
export type Completion = NonNullable<CompletionResponse['data']>;
export type CompletionInput = Parameters<CompletionCall>[0];
export type ReservationInput = Parameters<KernelClient['media']['post']>[0];

type ProblemBody = { type: string; title: string; status: number; code: string };
export class MediaProblem extends Error {
  readonly headers?: HeadersInit;
  constructor(
    readonly problem: ProblemBody,
    headers?: HeadersInit,
  ) {
    super(problem.code);
    if (headers !== undefined) this.headers = headers;
  }
}

export function problem(status: number, code: string, title: string): MediaProblem {
  return new MediaProblem({ type: `https://rezics.com/problems/${code}`, title, status, code });
}
export const notFound = () => problem(404, 'not_found', 'Not Found');
export const dependencyUnavailable = (status = 502) =>
  problem(status, 'dependency_unavailable', 'Dependency Unavailable');

export function problemResponse(error: unknown, headers?: HeadersInit): Response {
  const failure = error instanceof MediaProblem ? error : dependencyUnavailable();
  return Response.json(failure.problem, {
    status: failure.problem.status,
    headers: {
      ...Object.fromEntries(new Headers(failure.headers)),
      ...Object.fromEntries(new Headers(headers)),
      'content-type': 'application/problem+json',
      'cache-control': 'private, no-store',
    },
  });
}

export function mediaClient(origin: string): KernelClient {
  const kernelFetch: typeof fetch = globalThis.fetch;
  return createKernelClient(origin, {
    fetch: ((input, init) => kernelFetch(input, { ...init, redirect: 'manual' })) as typeof fetch,
  });
}

const viewerHeaders = (credential: string | null) => (credential === null ? {} : { authorization: credential });

function retryAfterHeader(headers: HeadersInit | undefined): HeadersInit | undefined {
  if (headers === undefined) return undefined;
  const value = new Headers(headers).get('retry-after');
  if (value === null || value === '') return undefined;
  return { 'retry-after': value };
}

function throwClientError(
  error: { value: unknown; status: number },
  headers: HeadersInit | undefined = undefined,
): never {
  const body = error.value as Partial<ProblemBody> | null;
  const forwarded = retryAfterHeader(headers);
  if (isPlatformClosedProblem(error.status, body)) {
    const problemBody = { type: body!.type!, title: body!.title!, code: body!.code!, status: error.status };
    if (forwarded === undefined) throw new MediaProblem(problemBody);
    throw new MediaProblem(problemBody, forwarded);
  }
  if (body && typeof body.type === 'string' && typeof body.title === 'string' && typeof body.code === 'string') {
    const problemBody = { type: body.type, title: body.title, code: body.code, status: error.status };
    if (forwarded === undefined) throw new MediaProblem(problemBody);
    throw new MediaProblem(problemBody, forwarded);
  }
  throw dependencyUnavailable();
}

export async function readReservation(client: KernelClient, id: string, credential: string | null): Promise<Media> {
  const result = await client.media({ id }).get({ headers: viewerHeaders(credential) });
  if (result.error) throwClientError(result.error, result.headers);
  return result.data.media;
}

export async function reserveMedia(
  client: KernelClient,
  credential: string | null,
  input: ReservationInput,
  idempotencyKey: string = crypto.randomUUID(),
): Promise<Media> {
  const result = await client.media.post(input, {
    headers: { ...viewerHeaders(credential), 'idempotency-key': JSON.stringify(idempotencyKey) },
  });
  if (result.error) throwClientError(result.error, result.headers);
  return result.data.media;
}

const adviceMediaTypes = ['image/avif', 'image/gif', 'image/jpeg', 'image/png', 'image/webp'] as const;
export type AvatarUploadAdvice = {
  viewerState: 'signed_in';
  viewer: { accountId: string };
  target: { containerId: string; purpose: 'avatar' };
  constraints: { mediaTypes: typeof adviceMediaTypes; maxByteCount: 20971520 };
  allowedActions: ['upload'] | [];
};

function adviceGet(client: KernelClient): { get: (input: object) => Promise<unknown> } | undefined {
  const route = Reflect.get(client.media, 'avatar-upload-advice');
  if (!route || typeof route !== 'object') return undefined;
  const get = Reflect.get(route, 'get');
  return typeof get === 'function' ? { get: get.bind(route) } : undefined;
}

export function parseAvatarUploadAdvice(value: unknown, viewerId: string): AvatarUploadAdvice | null {
  if (!value || typeof value !== 'object') return null;
  const body = value as Record<string, unknown>;
  const viewer = body.viewer as Record<string, unknown> | undefined;
  const target = body.target as Record<string, unknown> | undefined;
  const constraints = body.constraints as Record<string, unknown> | undefined;
  const types = constraints?.mediaTypes;
  const actions = body.allowedActions;
  if (
    body.viewerState !== 'signed_in' ||
    !viewer ||
    typeof viewer.accountId !== 'string' ||
    viewer.accountId === '' ||
    viewer.accountId !== viewerId ||
    !target ||
    target.containerId !== viewer.accountId ||
    target.purpose !== 'avatar' ||
    !constraints ||
    !Array.isArray(types) ||
    types.length !== adviceMediaTypes.length ||
    adviceMediaTypes.some((type, index) => types[index] !== type) ||
    constraints.maxByteCount !== 20_971_520 ||
    !Array.isArray(actions) ||
    (actions.length !== 0 && (actions.length !== 1 || actions[0] !== 'upload'))
  )
    return null;
  return {
    viewerState: 'signed_in',
    viewer: { accountId: viewer.accountId },
    target: { containerId: viewer.accountId, purpose: 'avatar' },
    constraints: { mediaTypes: adviceMediaTypes, maxByteCount: 20_971_520 },
    allowedActions: actions.length === 1 ? ['upload'] : [],
  };
}

export async function readAvatarUploadAdvice(
  client: KernelClient,
  credential: string | null,
  viewerId: string,
): Promise<AvatarUploadAdvice> {
  const route = adviceGet(client);
  if (!route) throw dependencyUnavailable();
  const result = (await route.get({ headers: viewerHeaders(credential) })) as {
    data?: unknown;
    error?: { value: unknown; status: number };
    headers?: HeadersInit;
  };
  if (result.error) throwClientError(result.error, result.headers);
  const advice = parseAvatarUploadAdvice(result.data, viewerId);
  if (!advice) throw dependencyUnavailable();
  return advice;
}

export async function completeReservation(
  client: KernelClient,
  id: string,
  credential: string | null,
  input: CompletionInput,
): Promise<Completion> {
  const result = await client.media({ id }).$complete.post(input, {
    headers: {
      ...viewerHeaders(credential),
      'idempotency-key': JSON.stringify(`complete-${id}-${input.sha256}`),
    },
  });
  if (result.error) throwClientError(result.error, result.headers);
  return result.data;
}

export async function authorizeDownload(
  client: KernelClient,
  id: string,
  variant: string,
  credential: string | null,
): Promise<DownloadDecision> {
  try {
    const { data, error } = await client.media({ id }).$authorizeDownload.get({
      query: { variant },
      headers: viewerHeaders(credential),
    });
    if (error) throwClientError(error);
    return data;
  } catch {
    // All failed decisions conceal the object, including upstream failures.
    throw notFound();
  }
}
