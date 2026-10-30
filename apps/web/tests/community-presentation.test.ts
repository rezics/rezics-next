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

// Additional adapter/source cases; the original acceptance cases above remain unchanged.
import { selectRealmAppearance } from '../src/community/realm-presentation-native';
import { fromPlainText, serializeDocument } from '@rezics/document';

const nativeImage = {
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
const nativeBody = fromPlainText('Reading room rules\nDiscuss the work and respect other readers.');
const nativeDigest = Array.from(
  new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serializeDocument(nativeBody)))),
  (b) => b.toString(16).padStart(2, '0'),
).join('');

function nativeSource() {
  let head = current.head;
  let presentation = structuredClone(current.presentation);
  let manages = true;
  let finalContext = realm.realm.contextId;
  let realmReads = 0;
  let failure: number | 'lost' | null = null;
  let mediaState = 'available';
  let purpose = 'realm-icon';
  let boardRealm = realmId;
  let erased = false;
  const requests: Request[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      expect(request.headers.get('authorization')).toBe('Bearer manager');
      const path = new URL(request.url).pathname;
      const nativeRealm = () => ({
        ...realm.realm,
        headRevisionId: head,
        presentation,
        ownershipState: 'owned',
        governanceReadOnly: false,
        contextId: realmReads % 2 === 0 ? finalContext : realm.realm.contextId,
      });
      if (path === '/v1/viewerActions')
        return Response.json({
          resources: [
            {
              type: 'community.realm',
              id: realmId,
              viewerActions: manages ? [{ action: 'realm:manage', operations: ['realm.update'] }] : [],
            },
          ],
        });
      if (path === `/v1/realms/${realmId}/media`)
        return Response.json(
          {
            media: {
              id,
              state: 'reserved',
              containerId: realmId,
              purpose: (await request.json()).purpose,
              byteCount: 1,
              mediaType: 'image/png',
              sha256: null,
            },
          },
          { status: 201 },
        );
      if (path === `/v1/realms/${realmId}`) {
        if (request.method === 'PATCH') {
          if (failure === 'lost') throw new Error('Response lost');
          if (failure)
            return Response.json(
              { code: failure === 409 ? 'media_unavailable' : 'dependency_unavailable' },
              { status: failure },
            );
          expect(request.headers.get('if-match')).toBe(JSON.stringify(head));
          presentation = (await request.json()).presentation;
          head = revisionId;
        }
        realmReads++;
        return Response.json({ realm: nativeRealm() });
      }
      if (path === `/v1/spaces/${realm.realm.spaceId}`)
        return Response.json({
          space: { spaceId: realm.realm.spaceId, realmId, state: 'active' },
          community: {
            realmId,
            spaceId: realm.realm.spaceId,
            contextId: realm.realm.contextId,
            name: realm.realm.title,
            description: realm.realm.summary,
            avatar: presentation.avatarMediaId
              ? { state: 'available', value: nativeImage }
              : { state: 'none', value: null },
            banner: { state: 'none', value: null },
            members: { state: 'unknown', count: null, version: null },
            rules: presentation.rules
              ? {
                  state: 'available',
                  value: { ...presentation.rules, body: nativeBody, licence: 'CC-BY-4.0', sha256: nativeDigest },
                }
              : { state: 'none', value: null },
            join: { membership: 'unknown', action: null },
          },
        });
      if (path === `/v1/media/${id}`)
        return Response.json({ media: { id, state: mediaState, containerId: realmId, purpose } });
      if (path === `/v1/posts/${id}/revisions/${revisionId}`)
        return Response.json({
          post: {
            id,
            revisionId,
            boardId: revisionId,
            availability: erased ? 'erased' : 'available',
            visibility: 'published',
            body: erased ? null : nativeBody,
            sha256: erased ? null : nativeDigest,
            licence: 'CC-BY-4.0',
            securityRevision: '1',
          },
        });
      if (path === `/v1/boards/${revisionId}`) return Response.json({ board: { id: revisionId, realmId: boardRealm } });
      throw new Error(`Unexpected native request ${request.method} ${path}`);
    },
  });
  return {
    client,
    requests,
    deny: () => {
      manages = false;
    },
    move: () => {
      finalContext = id;
    },
    fail: (value: typeof failure) => {
      failure = value;
    },
    media: (state: string, value = 'realm-icon') => {
      mediaState = state;
      purpose = value;
    },
    rules: (value: string, removed = false) => {
      boardRealm = value;
      erased = removed;
    },
  };
}

test('the assigned real current-authorized journey binds its native source while privacy retry and request bounds remain meaningful', async () => {
  const native = nativeSource();
  const read = await readRealmAppearance(native.client, 'Bearer manager', realmId);
  expect(read.kind).toBe('ready');
  expect(native.requests).toHaveLength(4);
  const reserved = await reserveRealmMedia(native.client, 'Bearer manager', realmId, {
    purpose: 'realm-icon',
    mediaType: 'image/png',
    byteCount: 1,
  });
  expect(reserved.id).toBe(id);
  const image = await selectRealmAppearance(
    { kind: 'image', realmId, mediaId: id, purpose: 'realm-icon' },
    native.client,
    'Bearer manager',
  );
  expect(image).toEqual({ kind: 'image-reference', mediaId: id, realmId, purpose: 'realm-icon' });
  expect(image).not.toHaveProperty('image');
  const rules = await selectRealmAppearance(
    { kind: 'rules', realmId, postId: id, revisionId },
    native.client,
    'Bearer manager',
  );
  expect(rules).toMatchObject({ kind: 'rules', rules: { title: 'Reading room rules', postId: id, revisionId } });
  const command = {
    realmId,
    head: current.head,
    key: id,
    presentation: { avatarMediaId: id, bannerMediaId: null, rules: { postId: id, revisionId } },
  };
  const result = await changeRealmAppearance(command, native.client, 'Bearer manager');
  expect(result).toMatchObject({
    kind: 'confirmed',
    snapshot: {
      presentation: command.presentation,
      head: revisionId,
      avatar: { state: 'available', value: nativeImage },
    },
  });
  const patch = native.requests.find((request) => request.method === 'PATCH')!;
  expect(patch.headers.get('idempotency-key')).toBe(JSON.stringify(id));
  expect(patch.headers.get('if-match')).toBe(JSON.stringify(current.head));
  expect(native.requests).toHaveLength(24); // 4 read, 1 reserve, 6 image, 8 rules, 5 save/confirmation.
  expect(
    native.requests.some((request) => /accounts|contexts|members|\/v1\/media$/.test(new URL(request.url).pathname)),
  ).toBe(false);
});

test('current native denial, binding movement and invalid sources disclose no successful choice', async () => {
  const denied = nativeSource();
  denied.deny();
  expect(await readRealmAppearance(denied.client, 'Bearer manager', realmId)).toEqual({ kind: 'hidden' });
  expect(denied.requests).toHaveLength(2);
  const moved = nativeSource();
  moved.move();
  expect(await readRealmAppearance(moved.client, 'Bearer manager', realmId)).toEqual({ kind: 'hidden' });
  for (const [state, purpose] of [
    ['processing', 'realm-icon'],
    ['erased', 'realm-icon'],
    ['available', 'realm-banner'],
  ]) {
    const source = nativeSource();
    source.media(state!, purpose!);
    expect(
      await selectRealmAppearance(
        { kind: 'image', realmId, mediaId: id, purpose: 'realm-icon' },
        source.client,
        'Bearer manager',
      ),
    ).toEqual({ kind: 'unavailable' });
  }
  for (const [otherRealm, erased] of [
    [revisionId, false],
    [realmId, true],
  ] as const) {
    const source = nativeSource();
    source.rules(otherRealm, erased);
    expect(
      await selectRealmAppearance({ kind: 'rules', realmId, postId: id, revisionId }, source.client, 'Bearer manager'),
    ).toEqual({ kind: 'unavailable' });
  }
});

test('native media conflicts and lost save responses retain the original draft head and intent key', async () => {
  const native = nativeSource();
  const initial = await readRealmAppearance(native.client, 'Bearer manager', realmId);
  const control = createRealmAppearance(
    realmId,
    initial,
    {
      read: () => readRealmAppearance(native.client, 'Bearer manager', realmId),
      change: (command) => changeRealmAppearance(command, native.client, 'Bearer manager'),
      select: (choice) => selectRealmAppearance(choice, native.client, 'Bearer manager'),
      upload: async () => ({ id }),
      resume: async () => ({ id }),
    },
    () => id,
  );
  control.choose('avatar', { kind: 'image-reference', mediaId: id, realmId, purpose: 'realm-icon' });
  native.fail('lost');
  await control.save();
  const attempt = structuredClone(control.getSnapshot().attempt);
  expect(control.getSnapshot().phase).toBe('uncertain');
  native.fail(503);
  await control.save();
  expect(control.getSnapshot().phase).toBe('uncertain');
  expect(control.getSnapshot().attempt).toEqual(attempt);
  native.fail(409);
  await control.save();
  expect(control.getSnapshot().phase).toBe('conflict');
  expect(control.getSnapshot().attempt).toEqual(attempt);
  expect(control.getSnapshot().draft?.presentation.avatarMediaId).toBe(id);
  const patches = native.requests.filter((request) => request.method === 'PATCH');
  expect(patches).toHaveLength(3);
  expect(await patches[0]!.clone().text()).toBe(await patches[1]!.clone().text());
  expect(patches[0]!.headers.get('idempotency-key')).toBe(patches[1]!.headers.get('idempotency-key'));
});

// The page play function checks the hydrated main and production panel in the normal Storybook queue.
// This local boundary case also guards the host responses and derivative files used by that page.
test('actual Realm appearance management Page uses current route/native admission composition and reaches its real main-content without a resource404 or fake permission', async () => {
  const { createStoryRecordedKernelFetch } = await import('../src/kernel/fake');
  const { available, appearancePath, appearanceAddress, appearanceSpaceId } =
    await import('../src/kernel/fake/community');
  const { locateRealm, loadSpacePage } = await import('../src/community/space');
  const { RealmAppearanceSettings } = await import('../src/community/realm-presentation-settings');
  const { createElement } = await import('react');
  const { renderToString } = await import('react-dom/server');
  const { m } = await import('../src/paraglide/messages.js');
  const story = await Bun.file(new URL('../src/stories/realm-presentation-page.stories.tsx', import.meta.url)).text();
  expect(story).toContain('<PageStory visitor="Signed In" path={appearancePath} />');
  expect(story).not.toMatch(/PatternStory|fixtureAdapter|realmAppearance=/);
  const route = await Bun.file(new URL('../src/routes/spaces/$address.tsx', import.meta.url)).text();
  expect(route).toContain('<SpacePage page={page} />');
  const page = await Bun.file(new URL('../src/community/space-page.tsx', import.meta.url)).text();
  expect(page).toContain('<RealmAppearancePanel realmId={page.realm.id} />');

  const recorded = createStoryRecordedKernelFetch();
  const requests: Request[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      const response = await recorded(request);
      expect(response.status).toBe(200);
      return response;
    },
  });
  const request = new Request(`https://site.test/en${appearancePath}`);
  expect(await locateRealm(client, request, {}, { realmId: available.realmId }, 'anonymous')).toEqual({
    kind: 'redirect',
    address: appearanceAddress,
  });
  const loaded = await loadSpacePage(client, request, {}, { address: appearanceAddress }, 'anonymous');
  expect(loaded.space.id).toBe(appearanceSpaceId);
  expect(loaded.realm?.id).toBe(available.realmId);
  requests.length = 0;
  const read = await readRealmAppearance(client, 'Bearer recorded-story-token', available.realmId);
  expect(read).toEqual({ kind: 'ready', snapshot: available });
  expect(requests.map((value) => `${value.method} ${new URL(value.url).pathname}`)).toEqual([
    `GET /v1/realms/${available.realmId}`,
    'POST /v1/viewerActions',
    `GET /v1/spaces/${appearanceSpaceId}`,
    `GET /v1/realms/${available.realmId}`,
  ]);
  expect(requests.every((value) => value.headers.get('authorization') === 'Bearer recorded-story-token')).toBe(true);
  expect(await requests[1]!.clone().json()).toEqual({
    resources: [{ type: 'community.realm', id: available.realmId }],
  });
  expect(await readRealmAppearance(client, 'Bearer another-viewer', available.realmId)).toEqual({ kind: 'hidden' });
  expect(await readRealmAppearance(client, null, available.realmId)).toEqual({ kind: 'hidden' });
  const html = renderToString(
    createElement(RealmAppearanceSettings, {
      realmId: available.realmId,
      initial: read,
      adapter: {
        read: () => readRealmAppearance(client, 'Bearer recorded-story-token', available.realmId),
        change: async () => ({ kind: 'unavailable' }),
        select: async () => ({ kind: 'unavailable' }),
        upload: async () => {
          throw new Error('No upload in this read-only boundary case');
        },
        resume: async () => {
          throw new Error('No upload in this read-only boundary case');
        },
      },
    }),
  );
  expect(html).toContain(m.realm_appearance_heading());
  expect(html).toContain('A thoughtful reading room');
  for (const image of [available.avatar, available.banner]) {
    const src = realmImageSource(image)!;
    expect(html).toContain(src);
    expect(await Bun.file(new URL(`../.storybook${src}`, import.meta.url)).exists()).toBe(true);
  }
});

test('management host ownership read admits the configured native owner without bypassing current page continuity', async () => {
  const { createStoryRecordedKernelFetch } = await import('../src/kernel/fake');
  const { available, appearancePath, appearanceAddress, appearanceSpaceId } =
    await import('../src/kernel/fake/community');
  const { loadSpacePage } = await import('../src/community/space');
  const { readRealmClaim } = await import('../src/community/realm-claim-native');
  const { nativeContainerLifecycleAdapter } = await import('../src/community/container-lifecycle-native');
  const requests: Request[] = [];
  const recorded = createStoryRecordedKernelFetch();
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return recorded(request);
    },
  });
  const url = `https://site.test/en${appearancePath}`;
  const owner = 'Bearer recorded-story-token';
  const page = await loadSpacePage(client, new Request(url), {}, { address: appearanceAddress }, 'anonymous');
  const continuity = {
    realmId: available.realmId,
    spaceId: appearanceSpaceId,
    contextId: available.contextId,
    headRevisionId: available.head,
    ownershipState: 'owned',
    orphanedAt: null,
    claimEligibleAt: null,
    governanceReadOnly: false,
  };
  expect(page.realm?.continuity).toEqual(continuity);
  requests.length = 0;
  expect(
    await readRealmClaim(
      client,
      new Request(url, { headers: { authorization: owner } }),
      {},
      {
        realmId: available.realmId,
        credentialMode: 'session',
      },
    ),
  ).toEqual({ kind: 'ready', snapshot: continuity, admission: 'allowed' });
  expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
    `GET /v1/realms/${available.realmId}`,
    `GET /v1/realms/${available.realmId}/participation`,
    `GET /v1/realms/${available.realmId}`,
  ]);
  expect(requests.every((request) => request.headers.get('authorization') === owner)).toBe(true);
  expect(await readRealmAppearance(client, owner, available.realmId)).toEqual({ kind: 'ready', snapshot: available });
  expect(
    await readRealmClaim(
      client,
      new Request(url, { headers: { authorization: 'Bearer another-viewer' } }),
      {},
      { realmId: available.realmId, credentialMode: 'session' },
    ),
  ).toEqual({ kind: 'ready', snapshot: continuity, admission: 'denied' });
  // The older ordinary recording and absent lifecycle sources do not acquire fixture authority.
  expect(await readRealmClaim(client, new Request(url), {}, { realmId, credentialMode: 'anonymous' })).toEqual({
    kind: 'unavailable',
  });
  const lifecycle = nativeContainerLifecycleAdapter(client, owner, 'en');
  expect(await lifecycle.read({ kind: 'realm', id: available.realmId })).toEqual({ kind: 'unavailable' });
  expect(await lifecycle.read({ kind: 'space', id: appearanceSpaceId })).toEqual({ kind: 'unavailable' });
});

test('appearance action source failures offer an unavailable read retry while native denials remain hidden', async () => {
  const { createStoryRecordedKernelFetch } = await import('../src/kernel/fake');
  const { available } = await import('../src/kernel/fake/community');
  const { RealmAppearanceSettings } = await import('../src/community/realm-presentation-settings');
  const { createElement } = await import('react');
  const { renderToString } = await import('react-dom/server');
  const { m } = await import('../src/paraglide/messages.js');
  const recorded = createStoryRecordedKernelFetch();
  let status = 503;
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname === '/v1/viewerActions' && status !== 200)
        return Response.json({ code: status >= 500 ? 'dependency_unavailable' : 'forbidden' }, { status });
      return recorded(request);
    },
  });
  const read = () => readRealmAppearance(client, 'Bearer recorded-story-token', available.realmId);
  const adapter: RealmAppearanceAdapter = {
    read,
    change: async () => ({ kind: 'unavailable' }),
    select: async () => ({ kind: 'unavailable' }),
    upload: async () => {
      throw new Error('No upload in an unavailable read');
    },
    resume: async () => {
      throw new Error('No upload in an unavailable read');
    },
  };
  for (status of [401, 403, 404]) expect(await read()).toEqual({ kind: 'hidden' });
  for (status of [500, 503]) {
    const initial = await read();
    expect(initial).toEqual({ kind: 'unavailable' });
    const html = renderToString(
      createElement(RealmAppearanceSettings, { realmId: available.realmId, initial, adapter }),
    );
    expect(html).toContain(m.realm_appearance_unavailable());
    expect(html).toContain(m.realm_appearance_refresh());
    expect(html).not.toContain(m.realm_appearance_save());
    expect(html).not.toContain('A thoughtful reading room');
    const control = createRealmAppearance(available.realmId, initial, adapter);
    status = 200;
    await control.refresh();
    expect(control.getSnapshot().read).toEqual({ kind: 'ready', snapshot: available });
    expect(control.editable()).toBe(true);
  }
});
