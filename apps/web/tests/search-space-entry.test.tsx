import { expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DiscoveryResults } from '../src/search/discovery-results';
import { useDiscoveryPersonalResults } from '../src/search/discovery-personal-host';
import { parseDiscoveryPage, type DiscoveryPage, type DiscoveryState } from '../src/search/discovery';
import type { DiscoveryBoundPage } from '../src/search/discovery-personal-server';
import { SpaceEntryControls } from '../src/search/space-entry/controls';
import { createSpaceEntryCommands } from '../src/search/space-entry/commands';
import { createDiscoveryCommandRegistry } from '../src/search/discovery-personal-state';
import type { FollowWriteResult } from '../src/library/follow-records';
import { sessionQuery } from '../src/session/query';
import { viewerExposureQuery } from '../src/kernel/viewer-exposure';
const id = '00000000-0000-4000-8000-000000000811',
  realm = '00000000-0000-4000-8000-000000000812',
  reader = '00000000-0000-4000-8000-000000000813';
const returnTo = '/en/search?q=reading&kind=space&layout=rows&cursor=next#context';
function fixture(following = false): DiscoveryPage {
  return {
    hits: [
      {
        key: { owner: 'community', kind: 'space', route: 0, id },
        summary: {
          kind: 'space',
          value: {
            id,
            address: 'reading',
            title: 'Space title',
            summary: 'Current purpose',
            realm: { id: realm, title: 'Community' },
            presentation: {
              identity: { kind: 'realm', id: realm, name: 'Native identity' },
              avatar: { state: 'unavailable' },
            },
          },
        },
      },
    ],
    kinds: { values: [], next: null },
    next: 'continuation',
    as_of: '2026-11-04T00:00:00Z',
    spaceEntries: {
      reader,
      rows: [
        {
          id,
          entry: 'allowed',
          admission: 'allowed',
          destination: { kind: 'realm', realmId: realm },
          follow: { state: 'current', following, action: 'allowed' },
        },
      ],
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
test('wire rejects guessed carriers, reordered advice, foreign avatars and standalone substitutions', () => {
  const good = fixture();
  expect(parseDiscoveryPage(good)).toBeDefined();
  const wrong = structuredClone(good);
  wrong.spaceEntries!.rows[0]!.destination = { kind: 'space', spaceId: id, address: 'reading' };
  expect(parseDiscoveryPage(wrong)).toBeUndefined();
  const reordered = structuredClone(good);
  reordered.spaceEntries!.rows[0]!.id = realm;
  expect(parseDiscoveryPage(reordered)).toBeUndefined();
  const media = structuredClone(good),
    hit = media.hits[0]!;
  if (hit.summary.kind !== 'space') throw new Error('Space fixture');
  hit.summary.value.presentation!.avatar = {
    state: 'available',
    realmId: id,
    mediaId: realm,
    format: 'webp',
    width: 96,
  };
  expect(parseDiscoveryPage(media)).toBeUndefined();
});
test('eight locales render current identity, independent native entry and explicit follow advice without detail fetching', () => {
  const page = fixture(),
    row = page.spaceEntries!.rows[0]!;
  for (const locale of ['en', 'de', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant']) {
    const html = renderToStaticMarkup(
      <DiscoveryResults
        state={{ status: 'ready', page }}
        locale={locale}
        restartHref={returnTo}
        renderPersonal={() => <SpaceEntryControls id={id} row={row} locale={locale} returnTo={returnTo} />}
      />,
    );
    expect(html).toContain('Native identity');
    expect(html).toContain('Current purpose');
    expect(html).toContain(`/${locale}/realms/${realm}`);
    expect(html).not.toContain('/realms/global');
  }
  const anonymous = renderToStaticMarkup(
    <SpaceEntryControls
      id={id}
      row={{ ...row, follow: { state: 'sign-in' }, admission: 'sign-in' }}
      locale="en"
      returnTo={returnTo}
      signedOut
    />,
  );
  expect(anonymous).toContain(encodeURIComponent(returnTo));
  const disabled = renderToStaticMarkup(
    <SpaceEntryControls
      id={id}
      row={{ ...row, follow: { state: 'current', following: true, action: 'disabled' } }}
      locale="en"
      returnTo={returnTo}
    />,
  );
  expect(disabled).toContain('disabled');
  expect(disabled).toContain('Unfollow');
});
test('Space command registry bounds work and retires delayed writes before refresh or feedback', async () => {
  const registry = createDiscoveryCommandRegistry(),
    pending = deferred<FollowWriteResult>();
  let writes = 0,
    refreshes = 0,
    suppressed = 0;
  const controller = createSpaceEntryCommands({
    reader: { expectedReader: reader, expectedCredential: 'token' },
    current: () => true,
    registry,
    write: async (command) => {
      writes++;
      expect(command.targetId).toBe(id);
      return pending.promise;
    },
    suppress: () => {
      suppressed++;
    },
    refresh: async () => {
      refreshes++;
    },
  });
  const command = { targetId: id, following: true, idempotencyKey: crypto.randomUUID() };
  const writing = controller.execute(command);
  expect(await controller.execute(command)).toBeNull();
  controller.dispose();
  pending.resolve({ ok: true, following: true });
  expect(await writing).toBeNull();
  expect([writes, refreshes, suppressed]).toEqual([1, 0, 0]);
});
test('mounted Search preserves visit on failed follow, refreshes one aggregate on success and retires reader work', async () => {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: `https://site.invalid${returnTo}` });
  let scroll = 200;
  Object.defineProperty(window, 'scrollY', { get: () => scroll });
  window.scrollTo = (_x: number, y: number) => {
    scroll = y;
  };
  const keys = [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'HTMLSelectElement',
    'HTMLInputElement',
    'HTMLButtonElement',
    'Element',
    'Node',
    'Document',
    'DocumentFragment',
    'MutationObserver',
    'ResizeObserver',
    'getComputedStyle',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'IS_REACT_ACT_ENVIRONMENT',
  ];
  const saved = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of keys)
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value:
        key === 'window'
          ? window
          : key === 'IS_REACT_ACT_ENVIRONMENT'
            ? true
            : ['getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'].includes(key)
              ? window[key].bind(window)
              : window[key],
    });
  const { createRoot } = await import('react-dom/client');
  const host = window.document.createElement('main') as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: reader, csrfToken: 'credential' });
  client.setQueryData(viewerExposureQuery({ subject: reader, id: 1 }).queryKey, {
    subject: reader,
    admitted: ['personal_library'],
  });
  const source: DiscoveryState = { status: 'ready', page: fixture() };
  let reads = 0,
    following = false,
    pending = deferred<FollowWriteResult>();
  const writes: unknown[] = [];
  const late = deferred<DiscoveryBoundPage>();
  let delayRead = false;
  function Live() {
    const personal = useDiscoveryPersonalResults({
      enabled: true,
      source,
      request: { representation: 'discovery-v1', text: 'reading', limit: 100 },
      locale: 'en',
      returnTo,
      read: async () => {
        reads++;
        return delayRead ? late.promise : { state: { status: 'ready', page: fixture(following) }, capabilities: null };
      },
      writeSpaceFollow: async (command) => {
        writes.push(command);
        return pending.promise;
      },
    });
    return (
      <section ref={personal.regionRef} tabIndex={-1}>
        <DiscoveryResults
          state={personal.state ?? source}
          locale="en"
          restartHref={returnTo}
          renderPersonal={personal.renderPersonal}
        />
      </section>
    );
  }
  const follow = () => host.querySelector<HTMLButtonElement>(`[data-search-space-actions="${id}"] button`)!;
  try {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <Live />
        </QueryClientProvider>,
      ),
    );
    expect(reads).toBe(1);
    expect(follow().disabled).toBe(false);
    expect(host.querySelector(`a[href="/en/realms/${realm}"]`)).not.toBeNull();
    follow().focus();
    await act(async () => follow().click());
    expect(follow().getAttribute('aria-busy')).toBe('true');
    await act(async () => pending.resolve({ ok: false, reason: 'forbidden' }));
    expect(host.querySelector('[role=alert]')).not.toBeNull();
    expect(reads).toBe(1);
    expect(window.location.pathname + window.location.search + window.location.hash).toBe(returnTo);
    expect(scroll).toBe(200);
    pending = deferred();
    following = true;
    await act(async () => follow().click());
    await act(async () => pending.resolve({ ok: true, following: true }));
    expect(reads).toBe(2);
    expect(follow().textContent).toContain('Unfollow');
    expect(writes).toMatchObject([
      { targetId: id, following: true, expectedReader: reader, expectedCredential: 'credential' },
      { targetId: id, following: true },
    ]);
    pending = deferred();
    delayRead = true;
    await act(async () => follow().click());
    await act(async () =>
      client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', subject: null, csrfToken: null }),
    );
    await act(async () => pending.resolve({ ok: true, following: false }));
    expect(reads).toBe(2);
    expect(host.textContent).not.toContain('Unfollow');
    expect(host.querySelector(`a[href*="return_to=${encodeURIComponent(returnTo)}"]`)).not.toBeNull();
    late.resolve({ state: source, capabilities: null });
  } finally {
    await act(async () => root.unmount());
    client.clear();
    window.happyDOM.abort();
    for (const key of keys) {
      const descriptor = saved.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
