import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { createKernelClient } from '@rezics/client';
import * as start from '../.storybook/react-start';
import { RealmHomeHeader } from '../src/community/realm-home-header';
import type { RealmPresentationImage } from '../src/threads/board-community-source';
import type { RealmAppearanceSnapshot } from '../src/community/realm-presentation';
import {
  appearanceAddress,
  appearancePath,
  appearanceRecording,
  available,
  configured,
  image,
  bannerImage,
} from '../src/kernel/fake/community';
import { m } from '../src/paraglide/messages.js';
import { getLocale, setLocale } from '../src/paraglide/runtime.js';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
const { loadSpacePage } = await import('../src/community/space');
const require = createRequire(import.meta.url);
const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));

const title = `A community for careful reading — ${'UnbrokenRealmTitle'.repeat(12)}`;
const description = `${'Read together and compare interpretations with care. '.repeat(20)}\n${'UnbrokenDescription'.repeat(24)}\nThe last supplied description sentence.`;
const spaceSummary = `${'The carrying Space has its own introduction. '.repeat(16)}\nThe last supplied Space summary sentence.`;
const rulesText = `${'Mark spoilers and respect other readers. '.repeat(28)}\n${'UnbrokenRule'.repeat(24)}\nThe last supplied rule sentence.`;
const avatar: RealmPresentationImage = {
  ...image,
  credit: {
    rightsHolder: `Avatar illustrator — ${'UnbrokenCredit'.repeat(14)}`,
    via: { name: 'Avatar original source', url: 'https://example.org/avatar' },
    license: 'CC-BY-4.0',
    obligations: ['cc:Attribution'],
  },
};
const banner: RealmPresentationImage = {
  ...bannerImage,
  credit: {
    rightsHolder: `Banner photographer — ${'UnbrokenCredit'.repeat(14)}`,
    via: { name: 'Banner original source', url: 'https://example.org/banner' },
    license: 'CC-BY-SA-4.0',
    obligations: ['cc:Attribution', 'cc:ShareAlike'],
  },
};
type State =
  | 'available'
  | 'no-images'
  | 'optional-unavailable'
  | 'source-unavailable'
  | 'current-denied'
  | 'orphan-readable'
  | 'protected-denied'
  | 'removed';

async function load(state: State = 'available', suppliedDescription = description) {
  const fields: Pick<RealmAppearanceSnapshot, 'avatar' | 'banner' | 'rules'> =
    state === 'optional-unavailable'
      ? {
          avatar: { state: 'none', value: null },
          banner: { state: 'unavailable', value: null },
          rules: { state: 'unavailable', value: null },
        }
      : state === 'no-images'
        ? configured
        : {
            avatar: { state: 'available', value: avatar },
            banner: { state: 'available', value: banner },
            rules: {
              state: 'available',
              value: { ...available.presentation.rules!, title: 'Reading room rules', summary: rulesText },
            },
          };
  const snapshot: RealmAppearanceSnapshot = {
    ...(state === 'no-images' ? configured : available),
    title,
    ...fields,
  };
  const calls: string[] = [];
  let realmReads = 0;
  const client = createKernelClient('https://kernel.test', {
    fetch: Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const path = new URL(request.url).pathname;
        calls.push(`${request.method} ${path}`);
        expect(request.headers.get('authorization')).toBeNull();
        if (path === `/v1/realms/${available.realmId}`) {
          realmReads++;
          if (state === 'protected-denied') return Response.json({ code: 'not_found' }, { status: 404 });
        }
        if (path.endsWith('/presentation') && (state === 'source-unavailable' || state === 'current-denied'))
          return new Response(null, { status: state === 'current-denied' ? 403 : 503 });
        const response = await appearanceRecording(request, snapshot);
        if (!response) throw new Error(`Unexpected header enrichment: ${request.method} ${path}`);
        if (response.realm && typeof response.realm === 'object')
          response.realm = {
            ...response.realm,
            summary: suppliedDescription,
            ...(state === 'orphan-readable'
              ? {
                  ownershipState: 'orphaned',
                  orphanedAt: '2026-09-01T00:00:00.000Z',
                  claimEligibleAt: '2026-10-01T00:00:00.000Z',
                  governanceReadOnly: true,
                }
              : {}),
            ...(state === 'removed' && realmReads > 1 ? { state: 'removed' } : {}),
          };
        if (response.space && typeof response.space === 'object')
          response.space = { ...response.space, title: 'Distinct Space identity', summary: spaceSummary };
        if (response.community && typeof response.community === 'object')
          response.community = { ...response.community, description: suppliedDescription };
        return Response.json(response);
      },
      { preconnect: fetch.preconnect },
    ),
  });
  const page = await loadSpacePage(
    client,
    new Request(`https://site.test/en${appearancePath}`),
    {},
    { address: appearanceAddress },
    'anonymous',
  );
  return { page, calls };
}

async function render(content: ReactNode) {
  setLocale('en', { reload: false });
  const route = createRootRoute({ component: () => content });
  const router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ['/'] }) });
  await router.load();
  const html = renderToStaticMarkup(createElement(RouterProvider, { router }));
  const window = new Window({ url: 'https://site.test/en/' });
  window.document.body.innerHTML = html;
  return { html, document: window.document as Document, close: () => window.happyDOM.abort() };
}

// Authored UNRUN. These actual-header observations do not establish browser layout or native acceptance.
test('same-Realm headers have independent associations and supplied children across distinct, same and absent Space context', async () => {
  const { page, calls } = await load();
  if (!page.realm) throw new Error('The recorded Realm is missing');
  const before = [...calls];
  const view = await render(
    <>
      <RealmHomeHeader
        realm={page.realm}
        space={page.space}
        participation={
          <details>
            <summary>First supplied participation</summary>
            <p>First local note</p>
          </details>
        }
      />
      <div dir="rtl">
        <RealmHomeHeader
          realm={page.realm}
          space={{ title, summary: spaceSummary }}
          participation={
            <details>
              <summary>Second supplied participation</summary>
              <p>Second local note</p>
            </details>
          }
        />
      </div>
      <RealmHomeHeader realm={page.realm} />
    </>,
  );
  try {
    const headers = Array.from(view.document.querySelectorAll<HTMLElement>('[data-slot="realm-home-presentation"]'));
    expect(headers).toHaveLength(3);
    const ids: string[] = [];
    for (const [index, header] of headers.entries()) {
      const heading = header.querySelector('h1[id], h2[id]')!;
      const rules = header.querySelector('section')!;
      const rulesHeading = rules.querySelector('h3')!;
      expect(header.getAttribute('aria-labelledby')).toBe(heading.id);
      expect(rules.getAttribute('aria-labelledby')).toBe(rulesHeading.id);
      for (const element of [heading, rulesHeading]) {
        expect(element.id.length).toBeGreaterThan(0);
        expect(view.document.getElementById(element.id)).toBe(element);
        ids.push(element.id);
      }
      expect(heading.textContent).toBe(title);
      expect(heading.tagName).toBe(index === 0 ? 'H2' : 'H1');
      expect(header.querySelectorAll('h1')).toHaveLength(1);
      expect(header.querySelector('h1')?.textContent).toBe(index === 0 ? page.space.title : title);
      expect(rulesHeading.textContent).toBe(m.board_community_rules());
      expect(Array.from(header.querySelectorAll('p')).some((p) => p.textContent === description)).toBe(true);
      for (const paragraph of rulesText.split('\n')) expect(rules.textContent).toContain(paragraph);
      expect(rules.textContent).toContain('Reading room rules');
      expect(rules.textContent).toContain('CC-BY-4.0');
      expect(header.querySelector('[class*="line-clamp"], [class*="truncate"]')).toBeNull();
      expect(header.textContent).toContain(m.board_community_members_unknown());
      expect(header.textContent).not.toContain(m.board_community_members({ count: 0 }));
      const links = Array.from(header.querySelectorAll('a'));
      expect(links.find((link) => link.textContent === m.board_community_rules_revision())?.getAttribute('href')).toBe(
        `/${getLocale()}/posts/${available.presentation.rules!.postId}/revisions/${available.presentation.rules!.revisionId}`,
      );
      for (const { credit } of [avatar, banner]) {
        const source = links.find((link) => link.textContent === credit!.via.name)!;
        expect(source.getAttribute('href')).toBe(credit!.via.url);
        expect(source.getAttribute('rel')).toBe('noopener noreferrer nofollow');
        expect(source.parentElement?.textContent).toContain(credit!.rightsHolder);
        expect(source.parentElement?.textContent).toContain(credit!.license);
        expect(source.parentElement?.closest('a')).toBeNull();
      }
    }
    expect(new Set(ids).size).toBe(6);
    expect(headers[0]!.textContent).toContain(spaceSummary);
    const link = headers[0]!.querySelector('h2 a')!;
    expect(link.getAttribute('href')).toBe(`/en/realms/${page.realm.id}`);
    expect(headers[1]!.querySelector('h1 a')).toBeNull();
    expect(headers[2]!.querySelector('h1 a')).toBeNull();
    expect(headers[0]!.textContent).toContain('First supplied participation');
    expect(headers[0]!.textContent).not.toContain('Second supplied participation');
    expect(headers[1]!.textContent).toContain('Second supplied participation');
    expect(headers[1]!.textContent).not.toContain('First supplied participation');
    expect(headers[2]!.querySelector('details')).toBeNull();
    expect(
      view.document.querySelector('[data-member-state], button, a[href*="/auth/"], a[href*="/access/"]'),
    ).toBeNull();
    for (const label of [
      m.realm_join(),
      m.realm_leave(),
      m.community_manage(),
      m.space_setup_entry(),
      m.realm_appearance_heading(),
    ])
      expect(view.html).not.toContain(label);
    expect(calls).toEqual(before);
    expect(calls).toHaveLength(8);
    expect(calls.every((call) => call.startsWith('GET '))).toBe(true);
  } finally {
    await view.close();
  }
});

test('hidden presentation emits no DOM, identities, Space context, images, rules, credit or supplied child', async () => {
  const { page } = await load('current-denied');
  if (!page.realm) throw new Error('The denied presentation lost its enclosing public Realm');
  expect(page.realm.presentation?.state).toBe('hidden');
  function MustNotMount() {
    throw new Error('A hidden participation child mounted');
  }
  expect(
    renderToStaticMarkup(<RealmHomeHeader realm={page.realm} space={page.space} participation={<MustNotMount />} />),
  ).toBe('');
});

test('native absent images, unavailable optional fields and unavailable public source remain distinct and fully readable', async () => {
  for (const state of ['no-images', 'optional-unavailable', 'source-unavailable'] as const) {
    const { page, calls } = await load(state);
    if (!page.realm) throw new Error('An optional source failure hid the public Realm');
    expect(page.realm.presentation?.state).toBe(state === 'source-unavailable' ? 'unavailable' : 'available');
    const before = [...calls];
    const view = await render(<RealmHomeHeader realm={page.realm} space={page.space} />);
    try {
      expect(view.document.querySelector('h2')?.textContent).toBe(title);
      expect(view.document.body.textContent).toContain(description);
      expect(view.document.body.textContent).toContain(spaceSummary);
      expect(view.html).toContain(m.board_community_members_unknown());
      expect(view.html).not.toContain(m.board_community_members({ count: 0 }));
      expect(view.html).toContain(
        state === 'no-images' ? m.board_community_rules_none() : m.board_community_rules_unavailable(),
      );
      if (state === 'source-unavailable')
        expect(view.document.querySelector('[role="status"]')?.textContent).toBe(
          m.board_community_source_unavailable(),
        );
      else {
        expect(view.document.querySelector('[role="status"]')).toBeNull();
        expect(view.html).toContain(m.realm_appearance_no_image());
        expect(view.html.includes(m.realm_appearance_image_unavailable())).toBe(state === 'optional-unavailable');
      }
      expect(view.document.querySelector('a[href*="/revisions/"], [data-slot="document-body"], button')).toBeNull();
      for (const absent of [
        image.id,
        bannerImage.id,
        'https://example.org/avatar',
        'https://example.org/banner',
        rulesText,
      ])
        expect(view.html).not.toContain(absent);
      expect(calls).toEqual(before);
    } finally {
      await view.close();
    }
  }
});

test('current denial, protected denial and removed sources disclose no header or cached presentation', async () => {
  for (const state of ['current-denied', 'protected-denied', 'removed'] as const) {
    const { page, calls } = await load(state);
    if (state === 'protected-denied') expect(page.realm).toBeNull();
    else {
      expect(page.realm?.presentation).toEqual({ state: 'hidden', value: null });
      expect(
        renderToStaticMarkup(
          <RealmHomeHeader realm={page.realm!} space={page.space} participation={<p>Private participation</p>} />,
        ),
      ).toBe('');
    }
    expect(calls.filter((call) => call.endsWith('/presentation'))).toHaveLength(state === 'protected-denied' ? 0 : 1);
    expect(calls.every((call) => call.startsWith('GET '))).toBe(true);
  }
});

test('a readable orphan retains public content and no inferred join, management or appearance authority', async () => {
  const { page, calls } = await load('orphan-readable');
  if (!page.realm) throw new Error('The readable orphan is missing');
  expect(page.realm.continuity?.governanceReadOnly).toBe(true);
  expect(page.realm.presentation?.state).toBe('available');
  const before = [...calls];
  const view = await render(<RealmHomeHeader realm={page.realm} space={page.space} />);
  try {
    expect(view.document.body.textContent).toContain(description);
    expect(view.document.body.textContent).toContain(rulesText.split('\n').at(-1)!);
    expect(view.html).toContain(m.board_community_members_unknown());
    expect(
      view.document.querySelector('button, [data-member-state], a[href*="/auth/"], a[href*="/access/"]'),
    ).toBeNull();
    for (const label of [
      m.realm_join(),
      m.realm_leave(),
      m.community_manage(),
      m.space_setup_entry(),
      m.realm_appearance_heading(),
    ])
      expect(view.html).not.toContain(label);
    expect(calls).toEqual(before);
  } finally {
    await view.close();
  }
});

test('an authored empty description never falls back to a different Realm summary', async () => {
  const { page } = await load('available', '');
  if (!page.realm) throw new Error('The public Realm is missing');
  const view = await render(<RealmHomeHeader realm={{ ...page.realm, summary: 'A different fallback summary' }} />);
  try {
    expect(view.html).not.toContain('A different fallback summary');
  } finally {
    await view.close();
  }
});
