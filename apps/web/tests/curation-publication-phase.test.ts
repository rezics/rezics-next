import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { PROFILE_FORMAT, type PresentationProfile } from '@rezics/composition';
import { publishProfile } from '../src/features/pages/curate';

const profile: PresentationProfile = {
  format: PROFILE_FORMAT,
  generic: { root: { props: {} }, content: [] },
  bases: [],
  types: [],
  routes: [],
};

test('an HTTP activation failure retains the completed publish phase', async () => {
  const digest = `sha256:${'a'.repeat(64)}`;
  const client = createKernelClient('https://kernel.invalid', {
    fetch: async (input, init) => {
      const path = input instanceof Request ? input.url : String(input);
      const activating = path.includes(':activate');
      return new Response(JSON.stringify(activating ? {} : { digest }), {
        status: activating ? 503 : 201,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  expect(
    await publishProfile(client, {
      profile,
      expectedHead: 7,
      keys: { publish: 'publish-key', activate: 'activate-key' },
      authorization: 'Bearer editor',
    }),
  ).toEqual({ ok: false, reason: 'unavailable', phase: 'activate' });
});
