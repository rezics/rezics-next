import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import * as v from 'valibot';
import realm from '../src/kernel/recorded/realm.json';
import {
  createRealmAppearance,
  realmImageSource,
  realmPresentationAssets,
  realmPresentationSchema,
  type RealmAppearanceAdapter,
  type RealmAppearanceCommand,
  type RealmAppearanceSnapshot,
} from '../src/community/realm-presentation';
import {
  readRealmAppearance,
  changeRealmAppearance,
  reserveRealmMedia,
} from '../src/community/realm-presentation-native';

const realmId = realm.realm.realmId;
const id = '01a1a000-0000-7000-8000-000000000011';
const revisionId = '01a1a000-0000-7000-8000-000000000012';
const current: RealmAppearanceSnapshot = {
  realmId,
  head: realm.realm.headRevisionId,
  title: realm.realm.title,
  contextId: realm.realm.contextId,
  state: 'active',
  canManage: true,
  presentation: { avatarMediaId: null, bannerMediaId: null, rules: null },
  avatar: { state: 'none', value: null },
  banner: { state: 'unavailable', value: null },
  rules: { state: 'none', value: null },
};

// Boundary coverage only. Real native/physical/browser acceptance belongs to integration.
test('actual Realm presentation settings and current-authorized community header retain native privacy and lifecycle authority', async () => {
  for (const finalState of ['active', 'removed', 'orphaned'] as const) {
    for (const manages of [false, true]) {
      let reads = 0;
      const requests: string[] = [];
      const client = createKernelClient('https://kernel.test', {
        fetch: async (input, init) => {
          const request = new Request(input, init);
          requests.push(new URL(request.url).pathname);
          expect(request.headers.get('authorization')).toBe('Bearer reader');
          if (request.method === 'POST')
            return Response.json({
              resources: [
                {
                  type: 'community.realm',
                  id: realmId,
                  viewerActions: manages ? [{ action: 'realm:manage', operations: ['realm.update'] }] : [],
                },
              ],
            });
          reads++;
          return Response.json({ realm: { ...realm.realm, state: reads > 1 ? finalState : 'active' } });
        },
      });
      const result = await readRealmAppearance(client, 'Bearer reader', realmId);
      expect(result.kind).toBe(manages && finalState === 'active' ? 'unavailable' : 'hidden');
      expect(result).not.toHaveProperty('snapshot');
      expect(requests).not.toContain('/v1/contexts');
      expect(reads).toBe(manages ? 2 : 1);
      await expect(
        reserveRealmMedia(client, 'Bearer reader', realmId, {
          purpose: 'realm-icon',
          mediaType: 'image/png',
          byteCount: 1,
        }),
      ).rejects.toMatchObject({ problem: { status: 503 } });
    }
  }
  const noNetwork = createKernelClient('https://kernel.test', {
    fetch: async () => {
      throw new Error('Unexpected request');
    },
  });
  expect(await readRealmAppearance(noNetwork, null, realmId)).toEqual({ kind: 'hidden' });
  expect(v.safeParse(realmPresentationSchema, { avatarMediaId: null, bannerMediaId: null }).success).toBe(false);
  expect(v.safeParse(realmPresentationSchema, { ...current.presentation, contextId: id }).success).toBe(false);
  expect(realmImageSource({ state: 'unavailable', value: null })).toBeNull();
  expect(realmImageSource({ state: 'none', value: null })).toBeNull();
  const image = {
    id,
    containerId: realmId,
    digest: 'a'.repeat(64),
    width: 320,
    height: 200,
    variants: [
      { format: 'webp' as const, width: 160, height: 100 },
      { format: 'avif' as const, width: 320, height: 200 },
    ],
    placeholder: null,
    focalPoint: null,
    credit: null,
  };
  expect(realmImageSource({ state: 'available', value: image })).toBe(`/media/${id}/avif-320`);
  expect(realmImageSource({ state: 'available', value: { ...image, variants: [] } })).toBeNull();
  const assets = realmPresentationAssets({ ...current, avatar: { state: 'available', value: image } });
  expect(assets.avatar).toEqual({ state: 'available', value: image });
  expect(assets.banner).toEqual({ state: 'unavailable', value: null });
  expect(
    await changeRealmAppearance({ realmId, head: current.head, key: id, presentation: current.presentation }),
  ).toEqual({ kind: 'unavailable' });
});

test('draft selections, uploaded references and original requests survive manual retry and explicit conflict review', async () => {
  const commands: RealmAppearanceCommand[] = [];
  let outcome: 'unavailable' | 'conflict' | 'confirmed' = 'unavailable';
  let keys = 0;
  const image = {
    id,
    containerId: realmId,
    digest: 'a'.repeat(64),
    width: 320,
    height: 200,
    variants: [{ format: 'webp' as const, width: 320, height: 200 }],
    placeholder: null,
    focalPoint: null,
    credit: null,
  };
  let imageReady = false;
  let uploads = 0;
  const adapter: RealmAppearanceAdapter = {
    read: async () => ({ kind: 'ready', snapshot: { ...current, head: revisionId } }),
    change: async (command) => {
      commands.push(command);
      return outcome === 'confirmed'
        ? {
            kind: 'confirmed',
            snapshot: {
              ...current,
              head: revisionId,
              presentation: command.presentation,
              avatar: { state: 'available', value: image },
              rules: { state: 'available', value: { postId: id, revisionId, title: 'Rules', summary: '' } },
            },
          }
        : { kind: outcome };
    },
    select: async () => (imageReady ? { kind: 'image', image } : { kind: 'unavailable' }),
    upload: async () => {
      uploads++;
      return { id };
    },
    resume: async () => ({ id }),
  };
  const control = createRealmAppearance(realmId, { kind: 'ready', snapshot: current }, adapter, () => {
    keys++;
    return id;
  });
  // Resolving/previewing a candidate alone does not adopt it.
  await adapter.select({ kind: 'image', realmId, mediaId: id, purpose: 'realm-icon' });
  expect(control.getSnapshot().draft?.presentation).toEqual(current.presentation);
  await control.upload('avatar', new File(['image'], 'icon.png', { type: 'image/png' }));
  expect(control.getSnapshot().pendingUpload).toEqual({ slot: 'avatar', mediaId: id });
  await control.save();
  expect(commands).toHaveLength(0);
  imageReady = true;
  await control.upload('avatar');
  expect(uploads).toBe(1);
  expect(control.getSnapshot().draft?.presentation.avatarMediaId).toBe(id);
  control.choose('rules', { kind: 'rules', rules: { postId: id, revisionId, title: 'Rules', summary: '' } });
  await control.save();
  expect(control.getSnapshot().phase).toBe('uncertain');
  await control.refresh();
  control.clear('avatar');
  outcome = 'conflict';
  await control.save();
  expect(commands[1]).toEqual(commands[0]);
  expect(commands[1]?.head).toBe(current.head);
  expect(keys).toBe(1);
  await control.refresh();
  expect(control.getSnapshot().draft?.presentation.avatarMediaId).toBe(id);
  control.reviewConflict();
  outcome = 'confirmed';
  await control.save();
  expect(commands[2]?.head).toBe(revisionId);
  expect(commands[2]?.presentation).toEqual(commands[0]?.presentation);
  expect(keys).toBe(2);
  expect(control.getSnapshot().phase).toBe('saved');
  expect(control.getSnapshot().read.kind).toBe('ready');
  const hidden = createRealmAppearance(realmId, { kind: 'ready', snapshot: { ...current, state: 'removed' } }, adapter);
  expect(hidden.getSnapshot().read).toEqual({ kind: 'hidden' });
  await hidden.save();
  expect(commands).toHaveLength(3);
});

test('current unavailable reads conceal retained previews and cannot be overwritten by an older save response', async () => {
  let respond: ((value: Awaited<ReturnType<RealmAppearanceAdapter['change']>>) => void) | undefined;
  const adapter: RealmAppearanceAdapter = {
    read: async () => ({ kind: 'unavailable' }),
    change: () =>
      new Promise((resolve) => {
        respond = resolve;
      }),
    select: async () => ({ kind: 'unavailable' }),
    upload: async () => ({ id }),
    resume: async () => ({ id }),
  };
  const control = createRealmAppearance(realmId, { kind: 'ready', snapshot: current }, adapter, () => id);
  const pending = control.save();
  const attempt = structuredClone(control.getSnapshot().attempt);
  control.observe({ kind: 'unavailable' });
  expect(control.getSnapshot().read).toEqual({ kind: 'unavailable' });
  respond?.({ kind: 'confirmed', snapshot: { ...current, head: revisionId } });
  await pending;
  expect(control.getSnapshot().read).toEqual({ kind: 'unavailable' });
  expect(control.getSnapshot().draft?.presentation).toEqual(current.presentation);
  expect(control.getSnapshot().attempt).toEqual(attempt);
  expect(control.getSnapshot().phase).toBe('uncertain');
});
