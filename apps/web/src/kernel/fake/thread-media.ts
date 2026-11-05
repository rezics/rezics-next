import type { KernelRecording } from '../fake.ts';
import type { FakeRoute } from '../fake-modules.ts';

const mediaState = new Map<number, string>([
  [0, 'reserved'],
  [1, 'uploaded'],
  [2, 'rejected'],
  [3, 'erased'],
  [4, 'missing'],
  [5, 'available'],
]);

function requestBody(request: Request): Promise<Record<string, unknown> | undefined> {
  return request
    .clone()
    .json()
    .then((value: unknown) =>
      value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined,
    )
    .catch(() => undefined);
}

function unavailable(): KernelRecording {
  return {
    status: 409,
    type: 'https://rezics.com/problems/media_unavailable',
    title: 'Media unavailable',
    code: 'media_unavailable',
    retryable: false,
    effect_status: 'not_applied',
    request_id: '00000000-0000-7000-8000-000000000001',
  };
}

async function writeWithImages({ request }: { request: Request }): Promise<KernelRecording | undefined> {
  const body = await requestBody(request);
  return Array.isArray(body?.mediaIds) && body.mediaIds.length > 0 ? unavailable() : undefined;
}

function readMedia({ match }: { match: RegExpExecArray | null }): KernelRecording | undefined {
  const id = match?.[1];
  if (!id) return undefined;
  const selector = Number.parseInt(id.at(-1) ?? '0', 16) % mediaState.size;
  const state = mediaState.get(selector)!;
  if (state === 'missing')
    return {
      status: 404,
      type: 'https://rezics.com/problems/not_found',
      title: 'Not Found',
      code: 'not_found',
      retryable: false,
      effect_status: 'not_applicable',
      request_id: '00000000-0000-7000-8000-000000000002',
    };
  return {
    status: 200,
    media: { id, state },
  };
}

export const routes: FakeRoute[] = [
  {
    method: 'POST',
    path: /^\/v1\/(?:threads|threads\/[^/]+\/posts|posts\/[^/]+\/revisions)$/,
    story: writeWithImages,
    fixture: writeWithImages,
  },
  {
    method: 'GET',
    path: /^\/v1\/media\/([^/]+)$/,
    story: readMedia,
    fixture: readMedia,
  },
];
