import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReleaseFidelityTransport } from '../src/features/catalogue/release-fidelity/view';
import type { RelationSlot, RelationTransport } from '../src/subject/relation-candidates';
import { basedOnProperty, releaseFidelityFixture, releaseSubject } from '../src/kernel/fake/release-fidelity';
import { candidateContext } from '../src/subject/candidates';
import * as start from '../.storybook/react-start';

mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);

const { ReleaseFidelityPage } = await import('../src/features/catalogue/release-fidelity/view');
const { m } = await import('../src/paraglide/messages.js');
const options = { locale: 'en' as never };

type ReadAddress = Parameters<ReleaseFidelityTransport['read']>;
type PendingRead = { address: ReadAddress; resolve: (value: Awaited<ReturnType<ReleaseFidelityTransport['read']>>) => void };
type RelationReadCall = {
  holder: string;
  context: string | undefined;
  slot: RelationSlot | undefined;
  cursor?: string;
  session?: string;
};

async function waitFor(assertion: () => void) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      assertion();
      return;
    } catch (error) {
      if (attempt === 99) throw error;
      await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    }
  }
}

async function mount(
  fixture: ReturnType<typeof releaseFidelityFixture>,
  hooks: {
    holdNextDetail?: () => boolean;
    reads: ReadAddress[];
    relationReads: RelationReadCall[];
    pendingReads: PendingRead[];
  },
) {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/subjects/release/japanese-paperback/release' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    location: window.location,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLFormElement: window.HTMLFormElement,
    Element: window.Element,
    Node: window.Node,
    Event: window.Event,
    MouseEvent: window.MouseEvent,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    scrollTo: () => {},
    matchMedia: window.matchMedia.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

  const transport: ReleaseFidelityTransport = {
    read: (...address) => {
      hooks.reads.push(address);
      if (address[2] && hooks.holdNextDetail?.())
        return new Promise((resolve) => hooks.pendingReads.push({ address, resolve }));
      return fixture.read(...address);
    },
    facts: {
      read: async () => ({ ok: false, reason: 'unavailable' }),
      propose: async () => ({ ok: false, reason: 'uncertain' }),
    },
    relation: (holder, context): RelationTransport => ({
      read: async (slot, cursor, session) => {
        hooks.relationReads.push({ holder, context, slot, cursor, session });
        return { ok: false, reason: 'unavailable' };
      },
      propose: async () => ({ ok: false, reason: 'unavailable' }),
      confirm: async () => ({ ok: false, reason: 'unavailable' }),
    }),
    review: () => ({}) as never,
  };
  const { createRoot } = await import('react-dom/client');
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const route = createRootRoute({
    component: () => (
      <ReleaseFidelityPage
        id={releaseSubject}
        context={candidateContext}
        locale="en"
        search={async () => []}
        transport={transport}
      />
    ),
  });
  const router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ['/en/subjects/release'] }) });
  await act(async () => router.load());
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
  });
  await waitFor(() => expect(host.querySelector('[data-slot="release-related"] select')).not.toBeNull());

  const click = async (button: HTMLButtonElement) => {
    button.focus();
    await act(async () => button.dispatchEvent(new window.MouseEvent('click', { bubbles: true, detail: 0 })));
  };
  const byLabel = (label: string) => {
    const button = Array.from(host.querySelectorAll('button')).find((item) => item.textContent?.trim() === label);
    if (!(button instanceof window.HTMLButtonElement)) throw new Error(`Missing button: ${label}`);
    return button;
  };
  const selectStream = async (key: string) => {
    const select = host.querySelector<HTMLSelectElement>('[data-slot="release-related"] select');
    if (!select) throw new Error('Missing relation stream selector');
    await act(async () => {
      select.value = key;
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
  };
  const rows = () => Array.from(host.querySelectorAll<HTMLElement>('[data-slot="release-related"] ul > li'));
  let mounted = true;
  const unmount = async () => {
    if (!mounted) return;
    await act(async () => root.unmount());
    mounted = false;
  };
  const close = async () => {
    await unmount();
    client.clear();
    host.remove();
    for (const [key, descriptor] of previous)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    await window.happyDOM.close();
  };
  return { host, window, rows, click, byLabel, selectStream, pendingReads: hooks.pendingReads, close, unmount, waitFor };
}

async function chooseLaterBasedOnPage(visit: Awaited<ReturnType<typeof mount>>) {
  const stream = `forward:${basedOnProperty}`;
  const select = visit.host.querySelector<HTMLSelectElement>('[data-slot="release-related"] select');
  if (!select) throw new Error('Missing relation stream selector');
  if (select.value !== stream) await visit.selectStream(stream);
  await visit.waitFor(() => expect(visit.rows()).toHaveLength(20));
  const concealed = visit.rows()[10]!;
  expect(concealed.textContent).toContain(m.release_fidelity_related_concealed({}, options));
  expect(concealed.querySelector('a, button')).toBeNull();
  await visit.click(visit.byLabel(m.release_fidelity_next({}, options)));
  await visit.waitFor(() => expect(visit.rows()).toHaveLength(2));
}

test('a later page inspects one exact repeated occurrence and returns from its existing correction', async () => {
  const fixture = releaseFidelityFixture('ready', 'en', 22);
  const hooks = { reads: [] as ReadAddress[], relationReads: [] as RelationReadCall[], pendingReads: [] as PendingRead[] };
  const visit = await mount(fixture, hooks);
  try {
    await chooseLaterBasedOnPage(visit);
    const pageRead = hooks.reads.at(-1)!;
    expect(pageRead.slice(0, 2)).toEqual([`forward:${basedOnProperty}`, '20']);
    expect(pageRead[3]).toBe('release-session');

    const duplicateRows = visit.rows();
    expect(visit.host.textContent).toContain(m.release_fidelity_selection_local({}, options));
    expect(duplicateRows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('Repeated hardcover'),
      expect.stringContaining('Repeated hardcover'),
    ]);
    const occurrenceButton = duplicateRows[0]!.querySelector('button');
    if (!(occurrenceButton instanceof visit.window.HTMLButtonElement)) throw new Error('Missing row detail action');
    await visit.click(occurrenceButton);
    await visit.waitFor(() => expect(visit.host.querySelector('[data-slot="release-detail-facts"]')).not.toBeNull());

    const selected = visit.rows().find((row) => row.getAttribute('aria-current') === 'location');
    expect(selected).toBe(duplicateRows[0]);
    const identity = JSON.parse(selected!.dataset.selectedOccurrence!) as string[];
    expect(identity).toEqual([
      `forward:${basedOnProperty}`,
      basedOnProperty,
      'forward',
      releaseSubject,
      '00000000-0000-4000-8000-00000000a214',
      '00000000-0000-4000-8000-00000000a117',
    ]);
    expect(visit.rows()[1]?.getAttribute('aria-current')).toBeNull();
    expect(visit.host.textContent).toContain('fr');
    expect(visit.host.textContent).toContain('2019-11');
    expect(visit.host.textContent).toContain('978-1-11-000020-0');
    expect(visit.host.textContent).toContain('anidb:rel:0020');
    expect(visit.host.textContent).toContain(m.release_fidelity_historical({}, options));

    await visit.click(visit.byLabel(m.correction_title({}, options)));
    const relationLabel = m.relation_title({}, options);
    await visit.waitFor(() => expect(visit.host.querySelector(`[aria-label="${relationLabel}"]`)).not.toBeNull());
    await visit.click(visit.byLabel(m.relation_open({}, options)));
    await visit.waitFor(() => expect(hooks.relationReads.length).toBeGreaterThan(0));
    expect(hooks.relationReads[0]).toMatchObject({
      holder: releaseSubject,
      context: candidateContext,
      slot: { property: basedOnProperty, target: '00000000-0000-4000-8000-00000000a117', context: candidateContext },
      session: 'release-session',
    });
    expect(hooks.relationReads[0]?.slot?.target).not.toBe('00000000-0000-4000-8000-00000000a118');
    await visit.click(visit.byLabel(m.work_parts_draft_close({}, options)));
    await visit.waitFor(() => expect(visit.host.querySelector(`[aria-label="${relationLabel}"]`)).toBeNull());
    expect(visit.rows().find((row) => row.getAttribute('aria-current') === 'location')?.dataset.selectedOccurrence).toBe(
      JSON.stringify(identity),
    );
    expect(visit.window.document.activeElement?.id).toBe('release-selected-detail-heading');
    expect(visit.host.textContent).toContain('978-1-11-000020-0');
  } finally {
    await visit.close();
  }
});

test('detail failure retries the exact current page and occurrence without losing its list context', async () => {
  const fixture = releaseFidelityFixture('ready', 'en', 22);
  const hooks = { reads: [] as ReadAddress[], relationReads: [] as RelationReadCall[], pendingReads: [] as PendingRead[] };
  const visit = await mount(fixture, hooks);
  try {
    await chooseLaterBasedOnPage(visit);
    fixture.setScenario('detail-unavailable');
    await visit.click(visit.rows()[1]!.querySelector('button') as HTMLButtonElement);
    await visit.waitFor(() => expect(visit.host.textContent).toContain(m.release_fidelity_detail_unavailable({}, options)));
    expect(visit.rows()).toHaveLength(2);
    const failedAddress = hooks.reads.at(-1)!;
    expect(failedAddress).toEqual([
      `forward:${basedOnProperty}`,
      '20',
      '00000000-0000-4000-8000-00000000a117',
      'release-session',
    ]);
    expect(visit.rows()[1]?.getAttribute('aria-current')).toBe('location');
    expect(visit.host.querySelector('[data-slot="release-detail-facts"]')).toBeNull();

    fixture.setScenario('ready');
    await visit.click(visit.byLabel(m.release_fidelity_retry_current({}, options)));
    await visit.waitFor(() => expect(visit.host.querySelector('[data-slot="release-detail-facts"]')).not.toBeNull());
    expect(hooks.reads.at(-1)).toEqual(failedAddress);
    expect(visit.rows()[1]?.getAttribute('aria-current')).toBe('location');
    expect(visit.host.textContent).toContain('978-1-11-000020-0');
  } finally {
    await visit.close();
  }
});

test('equal replacement, A/B/A return and unmount retire late selected details', async () => {
  const fixture = releaseFidelityFixture('ready', 'en', 22);
  const hooks = { reads: [] as ReadAddress[], relationReads: [] as RelationReadCall[], pendingReads: [] as PendingRead[] };
  let holdCount = 0;
  const visit = await mount(fixture, {
    reads: hooks.reads,
    relationReads: hooks.relationReads,
    pendingReads: hooks.pendingReads,
    holdNextDetail: () => {
      if (!holdCount) return false;
      holdCount--;
      return true;
    },
  });
  try {
    await chooseLaterBasedOnPage(visit);
    holdCount = 1;
    await visit.click(visit.rows()[0]!.querySelector('button') as HTMLButtonElement);
    await visit.waitFor(() => expect(visit.pendingReads).toHaveLength(1));
    const firstPending = visit.pendingReads[0]!;

    await visit.click(visit.byLabel(m.release_fidelity_reload({}, options)));
    await visit.waitFor(() => expect(visit.host.querySelector('[data-slot="release-detail-facts"]')).not.toBeNull());
    await act(async () => firstPending.resolve(await fixture.read(...firstPending.address)));
    expect(visit.host.querySelector('[data-slot="release-detail-facts"]')).not.toBeNull();
    expect(visit.host.textContent).toContain('978-1-11-000020-0');

    await visit.click(visit.byLabel(m.release_fidelity_back_to_list({}, options)));
    await visit.waitFor(() => expect(visit.host.querySelector('[data-slot="release-detail"]')).toBeNull());
    holdCount = 1;
    await visit.click(visit.rows()[0]!.querySelector('button') as HTMLButtonElement);
    await visit.waitFor(() => expect(visit.pendingReads).toHaveLength(2));
    const retired = visit.pendingReads[1]!;
    await visit.selectStream('forward:wdt:P155');
    await visit.waitFor(() => expect(visit.rows()).toHaveLength(0));
    await visit.selectStream(`forward:${basedOnProperty}`);
    await visit.waitFor(() => expect(visit.rows()).toHaveLength(20));
    await act(async () => retired.resolve(await fixture.read(...retired.address)));
    expect(visit.host.querySelector('[data-slot="release-detail"]')).toBeNull();
    expect(visit.rows()).toHaveLength(20);
    expect(visit.rows().some((row) => row.getAttribute('aria-current') === 'location')).toBe(false);

    holdCount = 1;
    await visit.click(visit.rows()[0]!.querySelector('button') as HTMLButtonElement);
    await visit.waitFor(() => expect(visit.pendingReads).toHaveLength(3));
    const unmounted = visit.pendingReads[2]!;
    await visit.unmount();
    await act(async () => unmounted.resolve(await fixture.read(...unmounted.address)));
    expect(visit.host.textContent).toBe('');
  } finally {
    await visit.close();
  }
});
