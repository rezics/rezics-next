import { expect, test } from 'bun:test';
import { profileDigest, PROFILE_FORMAT, type CompositionDocument, type PresentationProfile } from '@rezics/composition';
import { SESSION_HEADER, type KernelClient } from '@rezics/client';
import { loadPresentationPreview, presentationPreviewClient } from '../src/features/pages/presentation-preview';

const document: CompositionDocument = {
  root: { props: {} },
  content: [{ type: 'Heading', props: { id: 'home', text: { en: 'Home' }, level: 1 } }],
};
const profile: PresentationProfile = {
  format: PROFILE_FORMAT,
  generic: document,
  bases: [],
  types: [],
  routes: [{ route: '/', document }],
};
const digest = profileDigest(profile);
const input = { target: { route: '/' }, locale: 'en' };
const page = { subject: null, profile: digest, template: { scope: 'route', key: '/' }, document, reads: {} };

function client(active: unknown): KernelClient {
  return {
    pages: { $read: { post: async () => ({ status: 200, data: page }) } },
    presentation: {
      active: { get: async () => ({ status: 200, data: active }) },
      profiles: () => ({ get: async () => ({ status: 200, data: { digest, profile } }) }),
    },
  } as unknown as KernelClient;
}

const inspect = (active: unknown) => loadPresentationPreview(client(active), input);

test.each([
  ['fractional head', { digest, head: 1.5 }],
  ['negative head', { digest, head: -1 }],
  ['unsafe head', { digest, head: Number.MAX_SAFE_INTEGER + 1 }],
  ['wrong-type head', { digest, head: '1' }],
  ['malformed digest', { digest: 'sha256:bad', head: 0 }],
])('rejects malformed active metadata: %s', async (_name, active) => {
  expect(await inspect(active)).toEqual({ ok: false, reason: 'unavailable' });
});

test('accepts a coherent profile at native head zero and reports a valid changed digest', async () => {
  expect(await inspect({ digest, head: 0 })).toMatchObject({ ok: true, head: 0 });
  expect(await inspect({ digest: `sha256:${'f'.repeat(64)}`, head: 0 })).toEqual({ ok: false, reason: 'changed' });
});

test.each(['aggregate', 'controls'] as const)('cancels anonymous %s reads and reopens fresh', async (phase) => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const requests: Request[] = [];
  const credentials: (RequestCredentials | undefined)[] = [];
  const client = presentationPreviewClient('https://kernel.invalid', (async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    credentials.push(init?.credentials);
    if (requests.length === (phase === 'aggregate' ? 1 : 3)) entered.resolve();
    if (phase === 'aggregate' || !request.url.endsWith('/pages:read')) {
      await release.promise;
      // The aggregate deliberately ignores abort; no later controls may start in that case.
      if (phase === 'controls') request.signal.throwIfAborted();
    }
    const body = request.url.endsWith('/pages:read')
      ? page
      : request.url.endsWith('/active')
        ? { digest, head: 17 }
        : { digest, profile };
    return Response.json(body);
  }) as typeof fetch);
  const lifetime = new AbortController();
  const pending = loadPresentationPreview(client, input, lifetime.signal);
  await entered.promise;
  lifetime.abort();
  expect(requests.every((request) => request.signal.aborted)).toBe(true);
  release.resolve();
  expect(await pending).toEqual({ ok: false, reason: 'unavailable' });
  expect(requests).toHaveLength(phase === 'aggregate' ? 1 : 3);
  expect(credentials).toEqual(requests.map(() => 'omit'));
  for (const request of requests) {
    expect(request.headers.has('authorization')).toBe(false);
    expect(request.headers.has('cookie')).toBe(false);
    expect(request.headers.has(SESSION_HEADER)).toBe(false);
    expect([request.redirect, request.cache]).toEqual(['manual', 'no-store']);
  }
  const fresh = new AbortController();
  expect(await loadPresentationPreview(client, input, fresh.signal)).toMatchObject({ ok: true, head: 17 });
  expect(requests.at(-1)!.signal.aborted).toBe(false);
});
