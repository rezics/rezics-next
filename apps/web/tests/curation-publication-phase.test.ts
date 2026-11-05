import { expect, test } from 'bun:test';
import type { KernelClient } from '@rezics/client';
import { PROFILE_FORMAT, profileDigest, type PresentationProfile } from '@rezics/composition';
import { publishProfile } from '../src/features/pages/curate';

const profile: PresentationProfile = {
  format: PROFILE_FORMAT,
  generic: { root: { props: {} }, content: [] },
  bases: [],
  types: [],
  routes: [],
};

test('an HTTP activation failure retains the completed publish phase', async () => {
  const digest = profileDigest(profile);
  const profiles = Object.assign(() => ({ $activate: { post: async () => ({ status: 503 }) } }), {
    post: async () => ({ status: 201, data: { digest } }),
  });
  const client = { presentation: { profiles } } as unknown as KernelClient;
  expect(
    await publishProfile(client, {
      profile,
      expectedHead: 7,
      keys: { publish: 'p', activate: 'a' },
      authorization: 'Bearer editor',
    }),
  ).toEqual({ ok: false, reason: 'unavailable', phase: 'activate' });
});
