// The content contract lives here until @rezics/client exports these calls.
export type Media = {
  id: string;
  state: 'reserved' | 'uploaded' | 'available' | 'rejected' | 'erased';
  byteCount: number;
  mediaType: string;
  sha256: string | null;
  containerId: string;
  uploaderId: string;
  key: string;
  reservationRequestId: string;
};
export type DownloadDecision = {
  allowed: true;
  key: string;
  sha256: string;
  mediaType: string;
  byteCount: number;
  publicCache: false;
  cacheControl: string;
};
export type Completion = { media: { id: string; state: 'uploaded' } };
export type CompletionInput = Pick<Media, 'uploaderId' | 'containerId' | 'reservationRequestId' | 'byteCount'> & { sha256: string };

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
export const dependencyUnavailable = (status = 502) => problem(status, 'dependency_unavailable', 'Dependency Unavailable');

export function problemResponse(error: unknown, headers?: HeadersInit): Response {
  const { problem: body } = error instanceof MediaProblem ? error : dependencyUnavailable();
  return Response.json(body, { status: body.status, headers: { ...Object.fromEntries(new Headers(headers)),
    'content-type': 'application/problem+json', 'cache-control': 'private, no-store' } });
}

function viewerHeaders(credential: string | null): Headers {
  const headers = new Headers();
  if (credential !== null) headers.set('authorization', credential);
  return headers;
}

async function call<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, redirect: 'manual' });
  if (response.status !== 200) {
    const body = await response.json() as Partial<ProblemBody>;
    if (typeof body.type === 'string' && typeof body.title === 'string' && typeof body.code === 'string')
      throw new MediaProblem({ type: body.type, title: body.title, code: body.code, status: response.status });
    throw dependencyUnavailable();
  }
  return response.json() as Promise<T>;
}

const mediaUrl = (origin: string, id: string) => `${origin.replace(/\/$/, '')}/v1/media/${encodeURIComponent(id)}`;

export async function readReservation(origin: string, id: string, credential: string | null): Promise<Media> {
  return (await call<{ media: Media }>(mediaUrl(origin, id), { headers: viewerHeaders(credential) })).media;
}

export function completeReservation(origin: string, id: string, token: string, input: CompletionInput): Promise<Completion> {
  return call(`${mediaUrl(origin, id)}:complete`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
      'idempotency-key': JSON.stringify(`complete-${id}-${input.sha256}`) },
    body: JSON.stringify(input),
  });
}

export async function authorizeDownload(origin: string, id: string, variant: string, credential: string | null): Promise<DownloadDecision> {
  try {
    return await call(`${mediaUrl(origin, id)}:authorizeDownload?variant=${encodeURIComponent(variant)}`, {
      headers: viewerHeaders(credential),
    });
  } catch {
    // All failed decisions conceal the object, including upstream failures.
    throw notFound();
  }
}
