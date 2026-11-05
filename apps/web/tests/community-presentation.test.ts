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

test('Realm appearance cache, drafts and uploads are scoped to the current signed-in subject', async () => {
  const panel = await Bun.file(new URL('../src/community/realm-presentation-panel.tsx', import.meta.url)).text();
  const settings = await Bun.file(new URL('../src/community/realm-presentation-settings.tsx', import.meta.url)).text();

  expect(panel).toContain('const { state, csrfToken, subject } = useSession();');
  expect(panel).toContain("const viewer = state === 'signed-in' && subject ? subject : null;");
  expect(panel).toContain("queryKey: ['realm-appearance', realmId, viewer]");
  expect(panel).toContain('enabled: personalRead.enabled && viewer !== null');
  expect(panel).toContain('key={`${realmId}:${viewer}`}');
  expect(settings).toContain('useEffect(() => () => control.cancelUpload(), [control]);');
});

test('The default admitted community management journey resolves a same-site image or exact rules revision link through native selection and saves the exact reviewed reference while stale selections and uncertain original writes stay isolated', async () => {
  const { mock } = await import('bun:test');
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.test/en/spaces/quiet-novel-club' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    location: window.location,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLButtonElement: window.HTMLButtonElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    matchMedia: window.matchMedia.bind(window),
    scrollTo: window.scrollTo.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const start = await import('../.storybook/react-start');
  mock.module('@tanstack/react-start', () => start);
  mock.module('@tanstack/react-start/server', () => start);
  mock.module('cloudflare:workers', () => ({ env: {} }));
  const query = { ...(await import('../src/kernel/query')) };
  mock.module('../src/kernel/query', () => ({ ...query, personalRead: { ...query.personalRead, enabled: true } }));
  const native = nativeSource();
  const selections: Parameters<RealmAppearanceAdapter['select']>[0][] = [];
  const commands: RealmAppearanceCommand[] = [];
  const releases: (() => void)[] = [];
  let holdNext = false;
  const actions = { ...(await import('../src/community/space-actions')) };
  mock.module('../src/community/space-actions', () => ({
    ...actions,
    readRealmAppearanceSettings: async () => readRealmAppearance(native.client, 'Bearer manager', realmId),
    resolveRealmAppearanceChoice: async ({ data }: { data: Parameters<RealmAppearanceAdapter['select']>[0] }) => {
      selections.push(structuredClone(data));
      const held = holdNext;
      holdNext = false;
      const candidate = await selectRealmAppearance(data, native.client, 'Bearer manager');
      return held ? new Promise((resolve) => releases.push(() => resolve(candidate))) : candidate;
    },
    changeRealmAppearanceSettings: async ({
      data,
      headers,
    }: {
      data: RealmAppearanceCommand;
      headers: HeadersInit;
    }) => {
      expect(new Headers(headers).get('X-CSRF-Token')).toBe('manager-csrf');
      commands.push(structuredClone(data));
      return changeRealmAppearance(data, native.client, 'Bearer manager');
    },
    // Other management operations are denied, so only actual native appearance admission exposes Manage.
    readSpaceSetup: async () => ({ kind: 'failure', reason: 'denied', status: 403 }),
    readRealmBans: async () => ({ state: 'forbidden' }),
    readContainerLifecycle: async () => ({ kind: 'refused', status: 403, code: 'forbidden' }),
    readRealmClaimState: async () => ({ kind: 'unavailable' }),
  }));
  const { act, createElement: h } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } = await import('@tanstack/react-router');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { sessionQuery, exposureQuery } = await import('../src/session/query');
  const { SpacePage } = await import('../src/community/space-page');
  const { loadSpacePage } = await import('../src/community/space');
  const { createStoryRecordedKernelFetch } = await import('../src/kernel/fake');
  const { m } = await import('../src/paraglide/messages.js');
  const { setLocale, localizeUrl } = await import('../src/paraglide/runtime.js');
  const { within, userEvent, waitFor } = await import('storybook/test');
  setLocale('en', { reload: false });
  const recorded = createKernelClient('https://kernel.test', { fetch: createStoryRecordedKernelFetch() });
  const page = await loadSpacePage(
    recorded,
    new Request(window.location.href),
    {},
    { address: 'quiet-novel-club' },
    'anonymous',
  );
  expect(page.realm?.id).toBe(realmId);
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  queries.setQueryData(sessionQuery.queryKey, {
    state: 'signed-in',
    subject: realm.realm.creator,
    csrfToken: 'manager-csrf',
  });
  queries.setQueryData(exposureQuery.queryKey, []);
  const route = createRootRoute({ component: () => h(SpacePage, { page }) });
  const router = createRouter({
    routeTree: route,
    history: createMemoryHistory({ initialEntries: ['/en/spaces/quiet-novel-club'] }),
  });
  await router.load();
  const host = window.document.createElement('main') as unknown as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const user = userEvent.setup({ document: window.document as unknown as Document });
  const view = within(host);
  const click = async (name: string) => act(async () => user.click(view.getByRole('button', { name })));
  const imageLink = `/media/${id}/webp-320`;
  const rulesLink = `/posts/${id}/revisions/${revisionId}`;
  const edit = async (label: string, value: string) => {
    const input = view.getByRole('textbox', { name: label });
    await act(async () => {
      await user.clear(input);
      await user.click(input);
      await user.paste(value);
    });
  };
  const preview = async (cost: number) => {
    const before = native.requests.length;
    await click(m.realm_appearance_preview());
    await waitFor(() => expect(native.requests).toHaveLength(before + cost));
  };
  try {
    await act(async () => root.render(h(QueryClientProvider, { client: queries }, h(RouterProvider, { router }))));
    await view.findByRole('button', { name: m.community_manage() });
    expect(selections).toHaveLength(0);
    expect(commands).toHaveLength(0);
    expect(native.requests).toHaveLength(4);
    expect(view.queryByRole('region', { name: m.realm_appearance_heading() })).toBeNull();
    await click(m.community_manage());
    await view.findByRole('region', { name: m.realm_appearance_heading() });
    await act(async () => user.click(view.getAllByRole('button', { name: m.realm_appearance_choose() })[0]!));
    for (const invalid of [
      id,
      `/media/${id}/original`,
      `/media/${id}/png-320`,
      `/media/${id}/webp-0`,
      '/media/not-an-id/webp-320',
      `https://foreign.test${imageLink}`,
      `https://reader:secret@site.test${imageLink}`,
      `https://@site.test${imageLink}`,
      `//site.test${imageLink}`,
      `/en${imageLink}`,
      `/ignored/..${imageLink}`,
      imageLink.replace('/media/', '/%6dedia/'),
      `${imageLink}?fetch=https://foreign.test/image.png`,
      `${imageLink}#save`,
    ]) {
      await edit(m.realm_appearance_image_link(), invalid);
      expect(view.queryByRole('alert')).toBeNull();
      await click(m.realm_appearance_preview());
      await view.findByText(m.realm_appearance_invalid_image_link());
      expect(view.getByRole('button', { name: m.realm_appearance_use_selection() }).hasAttribute('disabled')).toBe(
        true,
      );
    }
    expect(selections).toHaveLength(0);
    expect(native.requests).toHaveLength(4);

    // Editing invalidates an in-flight read even when its exact native response arrives later.
    await edit(m.realm_appearance_image_link(), `https://site.test${imageLink}`);
    holdNext = true;
    await preview(6);
    await waitFor(() => expect(releases).toHaveLength(1));
    expect(view.getByRole('button', { name: m.editor_cancel() }).hasAttribute('disabled')).toBe(false);
    await edit(m.realm_appearance_image_link(), 'changed link');
    await act(async () => releases.shift()!());
    expect(view.queryByText(m.realm_appearance_reference_pending())).toBeNull();
    expect(view.queryByRole('alert')).toBeNull();
    await edit(m.realm_appearance_image_link(), imageLink);
    await preview(6);
    await view.findByText(m.realm_appearance_reference_pending());
    expect(selections[1]).toEqual({ kind: 'image', realmId, mediaId: id, purpose: 'realm-icon' });
    expect(view.getByRole('link', { name: m.realm_appearance_source_link() }).getAttribute('href')).toBe(imageLink);
    expect(host.querySelector(`img[src="${imageLink}"]`)).toBeNull();
    await click(m.realm_appearance_use_selection());
    expect(commands).toHaveLength(0);
    expect(view.getByText(m.realm_appearance_reference_pending())).toBeDefined();
    expect(
      view.getByText(m.realm_appearance_selection_for({ slot: m.realm_appearance_icon(), realm: current.title })),
    ).toBeDefined();

    await click(m.realm_appearance_select_rules());
    await edit(m.realm_appearance_rules_link(), `/posts/${id}`);
    await click(m.realm_appearance_preview());
    await view.findByText(m.realm_appearance_invalid_rules_link());
    expect(selections).toHaveLength(2);
    await edit(m.realm_appearance_rules_link(), rulesLink);
    holdNext = true;
    await preview(8);
    await waitFor(() => expect(releases).toHaveLength(1));
    // The actual panel receives a fresh source at the same head. The old read must not cross it or a reopened selection.
    await act(async () => {
      for (const entry of queries.getQueryCache().findAll({ queryKey: ['realm-appearance', realmId] }))
        queries.setQueryData(entry.queryKey, {
          kind: 'ready',
          snapshot: { ...current, title: 'Refreshed reading room' },
        });
    });
    await waitFor(() => expect(view.queryByRole('textbox', { name: m.realm_appearance_rules_link() })).toBeNull());
    await click(m.realm_appearance_select_rules());
    await act(async () => releases.shift()!());
    expect(view.queryByText('Reading room rules')).toBeNull();
    expect(view.queryByRole('alert')).toBeNull();
    await edit(m.realm_appearance_rules_link(), `https://site.test/zh-Hant${rulesLink}`);
    await preview(8);
    await view.findByText('Reading room rules');
    expect(view.getByText('Discuss the work and respect other readers.')).toBeDefined();
    expect(view.getByRole('link', { name: m.realm_appearance_open_revision() }).getAttribute('href')).toBe(
      localizeUrl(new URL(rulesLink, window.location.origin)).pathname,
    );
    expect(selections[3]).toEqual({ kind: 'rules', realmId, postId: id, revisionId });
    await click(m.realm_appearance_use_selection());
    expect(commands).toHaveLength(0);
    native.fail('lost');
    await click(m.realm_appearance_save());
    await view.findByText(m.realm_appearance_uncertain());
    expect(commands).toHaveLength(1);
    const original = structuredClone(commands[0]!);
    expect(original).toEqual({
      realmId,
      head: current.head,
      key: expect.any(String),
      presentation: { avatarMediaId: id, bannerMediaId: null, rules: { postId: id, revisionId } },
    });
    expect(v.safeParse(v.pipe(v.string(), v.uuid()), original.key).success).toBe(true);
    expect(view.getByRole('button', { name: m.realm_appearance_select_rules() }).hasAttribute('disabled')).toBe(true);
    expect(
      view
        .getAllByRole('button', { name: m.realm_appearance_choose() })
        .every((button) => button.hasAttribute('disabled')),
    ).toBe(true);
    const beforeRetry = native.requests.length;
    await click(m.community_manage_close());
    await click(m.community_manage());
    expect(view.getByText(m.realm_appearance_uncertain())).toBeDefined();
    expect(native.requests).toHaveLength(beforeRetry);
    native.fail(null);
    await click(m.realm_appearance_retry());
    await view.findByText(m.realm_appearance_saved());
    expect(commands).toEqual([original, original]);
    expect(native.requests).toHaveLength(beforeRetry + 5);
    const patches = native.requests.filter((request) => request.method === 'PATCH');
    expect(patches).toHaveLength(2);
    for (const patch of patches) {
      expect(patch.headers.get('idempotency-key')).toBe(JSON.stringify(original.key));
      expect(patch.headers.get('if-match')).toBe(JSON.stringify(original.head));
    }
    expect(host.querySelector(`img[src="${imageLink}"]`)).not.toBeNull();
    expect(view.queryByText(m.realm_appearance_reference_pending())).toBeNull();
    expect(view.getByText('Reading room rules')).toBeDefined();
    expect(selections).toHaveLength(4);
  } finally {
    await act(async () => root.unmount());
    queries.clear();
    mock.module('../src/community/space-actions', () => actions);
    mock.module('../src/kernel/query', () => query);
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await window.happyDOM.abort();
  }
}, 20_000);
