import { expect, test } from 'bun:test';
import {
  PROFILE_FORMAT,
  profileDigest,
  type CompositionDocument,
  type PresentationProfile,
  type SelectedContext,
} from '@rezics/composition';
import type { KernelClient } from '@rezics/client';
import { loadPresentationPreview } from '../src/features/pages/presentation-preview';

const subject = '00000000-0000-8000-8000-000000000001';
const realm = '00000000-0000-8000-8000-000000000002';
const otherRealm = '00000000-0000-8000-8000-000000000003';
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
const selectedContext = {
  id: '00000000-0000-8000-8000-000000000004',
  population: { kind: 'realm', id: realm, title: 'Requested Realm' },
} satisfies SelectedContext;

function setup(context?: SelectedContext) {
  const controls = { pinned: 0, active: 0 };
  const page = {
    subject,
    ...(context ? { context } : {}),
    profile: digest,
    template: { scope: 'generic', key: null },
    document,
    reads: {},
  };
  const client = {
    pages: { $read: { post: async () => ({ status: 200, data: page }) } },
    presentation: {
      profiles: () => ({
        get: async () => {
          controls.pinned++;
          return { status: 200, data: { digest, profile } };
        },
      }),
      active: {
        get: async () => {
          controls.active++;
          return { status: 200, data: { digest, head: 0 } };
        },
      },
    },
  } as unknown as KernelClient;
  return { client, controls };
}

test.each([
  ['missing context', undefined],
  ['Global population', { id: '00000000-0000-8000-8000-000000000000', population: { kind: 'global' } }],
  [
    'another Realm',
    { id: '00000000-0000-8000-8000-000000000005', population: { kind: 'realm', id: otherRealm, title: 'Other Realm' } },
  ],
] as const)('rejects a requested Realm with %s before reading controls', async (_name, context) => {
  const { client, controls } = setup(context);
  expect(await loadPresentationPreview(client, { target: { subject, realm }, locale: 'en' })).toEqual({
    ok: false,
    reason: 'unavailable',
  });
  expect(controls).toEqual({ pinned: 0, active: 0 });
});

test('accepts the requested population through its native Context and keeps the template witness', async () => {
  const { client, controls } = setup(selectedContext);
  const result = await loadPresentationPreview(client, { target: { subject, realm }, locale: 'en' });
  expect(result).toMatchObject({
    ok: true,
    page: { subject, context: selectedContext, template: { scope: 'generic', key: null } },
  });
  expect(selectedContext.id).not.toBe(selectedContext.population.id);
  expect(controls).toEqual({ pinned: 1, active: 1 });
});

test('keeps an unscoped subject preview and its native template witness', async () => {
  const { client, controls } = setup();
  const result = await loadPresentationPreview(client, { target: { subject }, locale: 'en' });
  expect(result).toMatchObject({
    ok: true,
    page: { subject, template: { scope: 'generic', key: null } },
  });
  expect(controls).toEqual({ pinned: 1, active: 1 });
});
