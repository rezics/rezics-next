import type { KernelRecording } from '../fake.ts';
import type { FakeRoute } from '../fake-modules.ts';

const reusedId = '0192f3a0-6c1e-7b2a-9d4e-000000000075';

function refusal(): KernelRecording {
  return {
    status: 409,
    type: 'https://rezics.com/problems/media_unavailable',
    title: 'Media unavailable',
    code: 'media_unavailable',
    retryable: false,
    effect_status: 'not_applied',
    request_id: '00000000-0000-7000-8000-000000000075',
  };
}

async function write({ request }: { request: Request }): Promise<KernelRecording | undefined> {
  const body = (await request
    .clone()
    .json()
    .catch(() => undefined)) as { mediaIds?: unknown } | undefined;
  return Array.isArray(body?.mediaIds) && body.mediaIds.includes(reusedId) ? refusal() : undefined;
}

function read({ match }: { match: RegExpExecArray | null }): KernelRecording | undefined {
  if (match?.[1] !== reusedId) return undefined;
  return { status: 200, media: { id: reusedId, state: 'available' } };
}

export const routes: FakeRoute[] = [
  {
    method: 'POST',
    path: /^\/v1\/(?:threads|threads\/[^/]+\/posts|posts\/[^/]+\/revisions)$/,
    story: write,
    fixture: write,
  },
  { method: 'GET', path: /^\/v1\/media\/([^/]+)$/, story: read, fixture: read },
];
