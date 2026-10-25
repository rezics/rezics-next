import { createKernelClient, type KernelClient } from '@rezics/client';

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
  constructor(readonly problem: ProblemBody) {
    super(problem.code);
  }
}

export function problem(status: number, code: string, title: string): MediaProblem {
  return new MediaProblem({ type: `https://rezics.com/problems/${code}`, title, status, code });
}
export const notFound = () => problem(404, 'not_found', 'Not Found');
export const dependencyUnavailable = (status = 502) =>
  problem(status, 'dependency_unavailable', 'Dependency Unavailable');

export function problemResponse(error: unknown, headers?: HeadersInit): Response {
  const { problem: body } = error instanceof MediaProblem ? error : dependencyUnavailable();
  return Response.json(body, {
    status: body.status,
    headers: {
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

function throwClientError(error: { value: unknown; status: number }): never {
  const body = error.value as Partial<ProblemBody> | null;
  if (body && typeof body.type === 'string' && typeof body.title === 'string' && typeof body.code === 'string')
    throw new MediaProblem({ type: body.type, title: body.title, code: body.code, status: error.status });
  throw dependencyUnavailable();
}

export async function readReservation(client: KernelClient, id: string, credential: string | null): Promise<Media> {
  const { data, error } = await client.media({ id }).get({ headers: viewerHeaders(credential) });
  if (error) throwClientError(error);
  return data.media;
}

export async function reserveMedia(
  client: KernelClient,
  credential: string | null,
  input: ReservationInput,
): Promise<Media> {
  const { data, error } = await client.media.post(input, {
    headers: { ...viewerHeaders(credential), 'idempotency-key': JSON.stringify(crypto.randomUUID()) },
  });
  if (error) throwClientError(error);
  return data.media;
}

export async function completeReservation(
  client: KernelClient,
  id: string,
  credential: string | null,
  input: CompletionInput,
): Promise<Completion> {
  const { data, error } = await client.media({ id }).$complete.post(input, {
    headers: {
      ...viewerHeaders(credential),
      'idempotency-key': JSON.stringify(`complete-${id}-${input.sha256}`),
    },
  });
  if (error) throwClientError(error);
  return data;
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
