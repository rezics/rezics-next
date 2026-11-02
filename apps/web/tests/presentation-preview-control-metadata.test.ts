import { expect, test } from 'bun:test';
import { profileDigest, PROFILE_FORMAT, type CompositionDocument, type PresentationProfile } from '@rezics/composition';
import type { KernelClient } from '@rezics/client';
import { loadPresentationPreview } from '../src/features/pages/presentation-preview';

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
