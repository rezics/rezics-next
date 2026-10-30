import { expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createKernelClient } from '@rezics/client';
import { fromPlainText, serializeDocument } from '@rezics/document';
import * as start from '../.storybook/react-start';
import realmRecording from '../src/kernel/recorded/realm.json';
import spaceRecording from '../src/kernel/recorded/space.json';
import { available, appearanceSpaceId } from '../src/kernel/fake/community';
import type { CommunityPresentation } from '../src/threads/board-community-source';
import type { SpacePageData } from '../src/community/space';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
const session = await import('../src/session/query');
let signedIn = false;
mock.module('../src/session/query', () => ({
  ...session,
  useSession: () => ({
    state: signedIn ? 'signed-in' : 'signed-out',
    csrfToken: signedIn ? 'member-csrf' : null,
    subject: signedIn ? 'reader' : null,
  }),
}));
const { SpacePage } = await import('../src/community/space-page');
const { loadSpacePage } = await import('../src/community/space');
const { realmMembershipQuery } = await import('../src/community/realm-membership-queries');
const { m } = await import('../src/paraglide/messages.js');
const { setLocale } = await import('../src/paraglide/runtime.js');

const realm = {
  ...realmRecording.realm,
  realmId: available.realmId,
  spaceId: appearanceSpaceId,
  presentation: available.presentation,
  ownershipState: 'owned',
  orphanedAt: null,
  claimEligibleAt: null,
  governanceReadOnly: false,
};
const space = {
  ...spaceRecording.space,
  spaceId: appearanceSpaceId,
  realmId: realm.realmId,
  title: 'A separate Space identity',
};
const body = fromPlainText('Discuss the work, respect other readers, and mark spoilers.');
// Explicit boundary responses exercise the consumer; these are not native count or media evidence.
const community: CommunityPresentation = {
  realmId: realm.realmId,
  spaceId: space.spaceId,
  contextId: realm.contextId,
  name: realm.title,
  description: realm.summary,
  avatar: available.avatar,
  banner: available.banner,
  members: { state: 'current', count: 23, version: 'native-count-version' },
  rules: {
    state: 'available',
    value: {
      ...available.presentation.rules!,
      body,
      licence: 'CC-BY-4.0',
      sha256: createHash('sha256').update(serializeDocument(body)).digest('hex'),
    },
  },
  // Presentation metadata cannot replace the independent personal membership read.
  join: { membership: 'nonmember', action: 'join' },
};

async function load(
  options: {
    community?: unknown;
    status?: number;
    finalRealm?: Partial<typeof realm>;
    finalSpace?: Partial<typeof space>;
    realmDenied?: boolean;
  } = {},
) {
  const calls: string[] = [];
  let realmReads = 0;
  let spaceReads = 0;
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      calls.push(path);
      if (path.startsWith('/v1/spaceAddresses/')) return Response.json({ spaceId: space.spaceId });
      if (path === `/v1/spaces/${space.spaceId}`)
        return Response.json({ space: { ...space, ...(spaceReads++ ? options.finalSpace : {}) } });
      if (path === `/v1/realms/${realm.realmId}`) {
        if (options.realmDenied) return Response.json({ code: 'not_found' }, { status: 404 });
        return Response.json({ realm: { ...realm, ...(realmReads++ ? options.finalRealm : {}) } });
      }
      if (path === `/v1/realms/${realm.realmId}/presentation`)
        return Response.json({ community: options.community ?? community }, { status: options.status ?? 200 });
      if (path.endsWith('/boards') || path.endsWith('/publications')) return Response.json({ items: [], next: null });
      throw new Error(`Unexpected enrichment request: ${request.method} ${path}`);
    },
  });
  const page = await loadSpacePage(
    client,
    new Request('https://site.test/en/spaces/quiet-novel-club'),
    {},
    { address: 'quiet-novel-club' },
    'anonymous',
  );
  return { page, calls };
}

async function render(page: SpacePageData, member: 'member' | 'banned' | null = null) {
  signedIn = member !== null;
  const queries = new QueryClient();
  if (page.realm && member)
    queries.setQueryData(realmMembershipQuery(page.realm.id).queryKey, {
      state: member,
      idempotencyKey: crypto.randomUUID(),
    });
  const root = createRootRoute({ component: () => createElement(SpacePage, { page }) });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/'] }) });
  await router.load();
  try {
    return renderToStaticMarkup(
      createElement(QueryClientProvider, { client: queries }, createElement(RouterProvider, { router })),
    );
  } finally {
    queries.clear();
  }
}

test('Space home shows the adopted real Realm presentation and current count', async () => {
  setLocale('en', { reload: false });
  const { page, calls } = await load();
  expect(page.realm?.presentation).toEqual({ state: 'available', value: community });
  const html = await render(page);
  expect(html).toMatch(new RegExp(`<h1[^>]*>${space.title}</h1>`));
  expect(html).toContain(m.space_realm_heading());
  expect(html).toContain(realm.title);
  expect(html).toContain(m.board_community_members({ count: 23 }));
  expect(html).toContain('Discuss the work, respect other readers, and mark spoilers.');
  expect(html).toContain('CC-BY-4.0');
  expect(html).toContain(
    `/posts/${community.rules.state === 'available' ? community.rules.value.postId : ''}/revisions/`,
  );
  const identity = html.match(/<header\b[^]*?<\/header>/u)?.[0];
  const carried = html.split('data-slot="realm-home-presentation"')[1];
  expect(identity).not.toContain('/media/');
  expect(carried).toContain('data-slot="avatar"');
  expect(carried).toContain(available.presentation.bannerMediaId!);
  expect(html).toContain('/auth/sign-in?return_to=');
  const member = await render(page, 'member');
  expect(member).toContain('data-member-state="member"');
  expect(member).toContain(m.realm_leave());
  expect(member).not.toContain(`>${m.realm_join()}<`);
  const banned = await render(page, 'banned');
  expect(banned).toContain(m.realm_banned());
  expect(banned).not.toContain(`>${m.realm_join()}<`);
  expect(banned).not.toContain(`>${m.realm_leave()}<`);
  expect(calls.filter((path) => path.endsWith('/presentation'))).toHaveLength(1);
  const presentationIndex = calls.findIndex((path) => path.endsWith('/presentation'));
  expect(calls.slice(0, presentationIndex)).toContain(`/v1/realms/${realm.realmId}`);
  expect(calls.slice(0, presentationIndex)).toContain(`/v1/spaces/${space.spaceId}`);
  expect(calls.slice(presentationIndex + 1).sort()).toEqual(
    [`/v1/realms/${realm.realmId}`, `/v1/spaces/${space.spaceId}`].sort(),
  );
});

test('native concealed images and rules stay none while optional failures and unknown members stay honest', async () => {
  const { page } = await load({
    community: {
      ...community,
      avatar: { state: 'none', value: null },
      banner: { state: 'unavailable', value: null },
      rules: { state: 'none', value: null },
      members: { state: 'unknown', count: null, version: null },
    },
  });
  expect(page.realm?.presentation?.state).toBe('available');
  const html = await render(page);
  expect(html).toContain(m.realm_appearance_no_image());
  expect(html).toContain(m.realm_appearance_image_unavailable());
  expect(html).toContain(m.board_community_rules_none());
  expect(html).toContain(m.board_community_members_unknown());
  expect(html).not.toContain(m.board_community_members({ count: 0 }));
  expect(html).not.toContain('/media/');
  for (const source of [
    { status: 503 },
    { community: { ...community, members: { state: 'current', count: 23, version: '' } } },
    {
      community: {
        ...community,
        rules: {
          ...community.rules,
          value: {
            ...(community.rules.state === 'available' ? community.rules.value : {}),
            body: fromPlainText('x'.repeat(65537)),
          },
        },
      },
    },
  ]) {
    const failure = await load(source);
    expect(failure.page.realm?.presentation).toEqual({ state: 'unavailable', value: null });
  }
});

test('current denial, removal and changed carried bindings discard presentation without retry or cached success', async () => {
  for (const change of [
    { finalRealm: { state: 'removed' } },
    { finalRealm: { headRevisionId: crypto.randomUUID() } },
    { finalRealm: { contextId: crypto.randomUUID() } },
    { finalSpace: { realmId: crypto.randomUUID() } },
  ]) {
    const { page, calls } = await load(change);
    expect(page.realm?.presentation).toEqual({ state: 'hidden', value: null });
    expect(await render(page)).not.toContain('data-slot="realm-home-presentation"');
    expect(calls.filter((path) => path.endsWith('/presentation'))).toHaveLength(1);
  }
  expect((await load({ status: 503, finalRealm: { state: 'removed' } })).page.realm?.presentation?.state).toBe(
    'hidden',
  );
  expect((await load({ status: 403 })).page.realm?.presentation?.state).toBe('hidden');
  const denied = await load({ realmDenied: true });
  expect(denied.page.realm).toBeNull();
  expect(denied.calls.some((path) => path.endsWith('/presentation'))).toBe(false);
});
