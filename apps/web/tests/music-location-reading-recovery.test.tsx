import { expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import * as start from '../.storybook/react-start';
import { musicLocationExample } from '../src/features/catalogue/music-location-reader/examples';
import type {
  MusicLocationAddress,
  MusicLocationRead,
  MusicLocationTransport,
} from '../src/features/catalogue/music-location-reader/model';

mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
let routeTransport: MusicLocationTransport;
mock.module('../src/features/catalogue/music-location-reader/actions', () => ({
  readSubjectMusicLocation: ({ data }: { data: MusicLocationAddress }) => routeTransport(data),
}));
const { MusicLocationReader } = await import('../src/features/catalogue/music-location-reader/view');
const { MusicLocationOverview } = await import('../src/features/catalogue/music-location-reader/entry');
const fixture = musicLocationExample('admitted-place');
const first = await fixture.read({ ...fixture.address, stream: 'in:schema:location' });
if (!first.ok) throw new Error('Expected a released relationship fixture');
const venue = first;
const props = {
  subject: fixture.public,
  context: fixture.address.context,
  source: fixture.source,
  reader: null,
  locale: 'en',
  transport: fixture.read,
  initial: venue,
};

async function mount() {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.example/en/subjects/location/harbour-hall' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    Event: window.Event,
    MouseEvent: window.MouseEvent,
    MutationObserver: window.MutationObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    scrollTo: window.scrollTo.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const { createRoot } = await import('react-dom/client');
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['session'], { state: 'signed-out' });
  const render = async (node: ReactNode) => {
    await act(async () => {
      root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
    });
  };
  const button = (label: string) => {
    const target = [...host.querySelectorAll('button')].find((node) => node.textContent?.trim() === label);
    if (!target) throw new Error(`Missing button: ${label}`);
    return target;
  };
  const click = async (label: string) => {
    await act(async () => button(label).click());
  };
  return {
    host,
    client,
    render,
    button,
    click,
    close: async () => {
      await act(async () => root.unmount());
      client.clear();
      host.remove();
      for (const [key, value] of previous) {
        if (value) Object.defineProperty(globalThis, key, value);
        else Reflect.deleteProperty(globalThis, key);
      }
      await window.happyDOM.close();
    },
  };
}

test('ordinary overview separates a failed stream from accepted rows and retries its exact start address', async () => {
  const ui = await mount();
  const calls: MusicLocationAddress[] = [];
  let finish!: (result: MusicLocationRead) => void;
  const transport: MusicLocationTransport = (address) => {
    calls.push(address);
    return calls.length === 1
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : fixture.read(address);
  };
  try {
    await ui.render(
      <MusicLocationReader {...props} initial={{ ...venue, session: 'session:first' }} transport={transport} />,
    );
    await ui.click('In area');
    expect(ui.host.querySelector('[data-slot="music-location-selected"]')?.textContent).toContain('In area');
    expect(ui.host.querySelector('[data-slot="music-location-accepted"]')?.textContent).toContain(
      'Last accepted reading',
    );
    expect(ui.host.textContent).toContain('Harbour concert');
    expect(calls[0]).toEqual({ ...fixture.address, stream: 'out:schema:containedInPlace', session: 'session:first' });
    await ui.click('In area'); // Disabled while pending: no second dispatch.
    expect(calls).toHaveLength(1);
    await act(async () => finish({ ok: false, reason: 'unavailable' }));
    expect(ui.host.textContent).not.toContain('No readable relationships');
    expect(ui.button('Previous accepted address').disabled).toBe(true);
    expect(ui.host.querySelector('button[aria-pressed="true"]')?.textContent).toBe('In area');
    expect([...ui.host.querySelectorAll('button')].some((node) => node.textContent === 'Next page')).toBe(false);
    await ui.click('Retry this exact request');
    expect(calls[1]).toEqual(calls[0]);
    expect(ui.host.textContent).toContain('North Shore');
    expect(ui.host.textContent).not.toContain('Harbour concert');
    expect(ui.host.textContent).not.toContain('Last accepted reading');
  } finally {
    await ui.close();
  }
});

test('More, Previous and Start read only chosen opaque addresses, including exact failed continuation and session', async () => {
  const ui = await mount();
  const calls: MusicLocationAddress[] = [];
  let fail = true;
  const transport: MusicLocationTransport = async (address) => {
    calls.push(address);
    if (address.cursor && fail) return { ok: false, reason: 'unavailable' };
    return { ...venue, session: `session:${calls.length}`, next: `opaque:${calls.length}` };
  };
  try {
    await ui.render(
      <MusicLocationReader {...props} initial={{ ...venue, session: 'session:seed' }} transport={transport} />,
    );
    await ui.click('Next page');
    const failed = { ...fixture.address, stream: venue.stream!.key, cursor: venue.next!, session: 'session:seed' };
    expect(calls).toEqual([failed]);
    fail = false;
    await ui.click('Retry this exact request');
    expect(calls[1]).toEqual(failed);
    await ui.click('Previous accepted address');
    expect(calls[2]).toEqual({ ...fixture.address, stream: venue.stream!.key });
    expect(ui.button('Previous accepted address').disabled).toBe(true);
    for (let index = 0; index < 10; index++) await ui.click('Next page');
    const retained = calls.slice(-8);
    for (let index = 6; index >= 0; index--) {
      await ui.click('Previous accepted address');
      expect(calls.at(-1)).toEqual(retained[index]);
    }
    expect(ui.button('Previous accepted address').disabled).toBe(true);
    expect(ui.host.textContent).toContain('earliest retained address');
    const count = calls.length;
    await ui.click('Previous accepted address');
    expect(calls).toHaveLength(count);
    await ui.click('Start of selected relationship');
    expect(calls.at(-1)).toEqual({ ...fixture.address, stream: venue.stream!.key, session: `session:${count}` });
    expect(ui.button('Previous accepted address').disabled).toBe(true);
    expect(ui.host.textContent).not.toContain('earliest retained address');
  } finally {
    await ui.close();
  }
});

test('stale current-Subject recovery reloads the route and preserves its full region URL and requested stream', async () => {
  const ui = await mount();
  const url = `/subjects/${fixture.address.id}/harbour-hall?cursor=public-cursor&realm=public-realm&node=public-node`;
  const calls: MusicLocationAddress[] = [];
  let loads = 0;
  routeTransport = async (address) => {
    calls.push(address);
    if (address.revision === 1) return address.stream ? { ok: false, reason: 'stale' } : fixture.read(address);
    return { ...venue, session: 'new-session' };
  };
  const root = createRootRoute({ component: Outlet });
  const route = createRoute({
    getParentRoute: () => root,
    path: '/subjects/$id/$slug',
    loader: () => ({ ...fixture.public, subject: { ...fixture.public.subject, revision: ++loads } }),
    component: () => {
      const subject = route.useLoaderData();
      return (
        <MusicLocationOverview
          subject={subject}
          source={subject}
          context={fixture.address.context}
          locale="en"
          reader={null}
        />
      );
    },
  });
  const router = createRouter({
    routeTree: root.addChildren([route]),
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  try {
    await act(async () => router.load());
    await ui.render(<RouterProvider router={router} />);
    await ui.click('Venue for');
    expect(ui.host.textContent).toContain('The Subject changed');
    expect(ui.host.querySelector('a')).toBeNull();
    expect([...ui.host.querySelectorAll('button')].some((node) => node.textContent?.includes('Retry'))).toBe(false);
    await ui.click('Refresh current Subject');
    expect(loads).toBe(2);
    expect(router.state.location.href).toBe(url);
    expect(calls.at(-1)?.revision).toBe(2);
    expect(calls.at(-1)?.session).toBeUndefined();
    expect(calls.at(-1)?.stream).toBe('in:schema:location');
    expect(ui.host.textContent).toContain('Harbour concert');
  } finally {
    await ui.close();
  }
});

test('a refreshed stream must be newly admitted; invalid addresses expose explicit current choices without automatic refill', async () => {
  const ui = await mount();
  const calls: MusicLocationAddress[] = [];
  const transport: MusicLocationTransport = async (address) => {
    calls.push(address);
    return address.stream
      ? { ok: false, reason: 'invalid' }
      : { ...venue, streams: [], stream: undefined, rows: [], next: null };
  };
  try {
    await ui.render(
      <MusicLocationReader {...props} initial={undefined} restoreStream="out:retired-property" transport={transport} />,
    );
    expect(calls).toHaveLength(1);
    expect(ui.host.textContent).toContain('requested relationship is no longer available');
    expect(ui.host.querySelector('a')).toBeNull();
    await ui.click('Read current relationship choices');
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(fixture.address);
    expect(ui.host.textContent).toContain('Accepted reading');
  } finally {
    await ui.close();
  }
});

test('denied, withheld and changed results remove retained rows and offer no unavailable-address retry', async () => {
  for (const reason of ['denied', 'withheld', 'stale'] as const) {
    const ui = await mount();
    try {
      await ui.render(<MusicLocationReader {...props} transport={async () => ({ ok: false, reason })} />);
      await ui.click('Next page');
      expect(ui.host.querySelector('[data-slot="music-location-row"]')).toBeNull();
      expect(ui.host.querySelector('a')).toBeNull();
      expect([...ui.host.querySelectorAll('button')].some((node) => node.textContent?.includes('Retry'))).toBe(false);
    } finally {
      await ui.close();
    }
  }
});

test('endpoint focus returns only after a current keyboard origin leaves the window, and never steals moved focus', async () => {
  const ui = await mount();
  let now = Date.now();
  const clock = spyOn(Date, 'now').mockImplementation(() => now);
  try {
    await ui.render(<MusicLocationReader {...props} />);
    const anchor = ui.host.querySelector<HTMLAnchorElement>('a[target="_blank"]')!;
    const enter = () => {
      anchor.focus();
      anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    };
    const leave = () => {
      window.dispatchEvent(new Event('blur'));
      anchor.blur();
    };
    const back = () => window.dispatchEvent(new Event('focus'));
    enter();
    anchor.blur();
    back();
    expect(document.activeElement).toBe(document.body);
    enter();
    leave();
    back();
    expect(document.activeElement).toBe(anchor);
    enter();
    leave();
    ui.button('In area').focus();
    back();
    expect(document.activeElement).toBe(ui.button('In area'));
    anchor.focus();
    anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    leave();
    back();
    expect(document.activeElement).toBe(document.body);
    enter();
    now += 2_000;
    leave();
    back();
    expect(document.activeElement).toBe(document.body);
    enter();
    leave();
    now += 31_000;
    back();
    expect(document.activeElement).toBe(document.body);
    enter();
    leave();
    await ui.render(<MusicLocationReader {...props} source={{}} />);
    back();
    expect(document.activeElement).toBe(document.body);
    const currentAnchor = ui.host.querySelector<HTMLAnchorElement>('a[target="_blank"]')!;
    currentAnchor.focus();
    currentAnchor.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    window.dispatchEvent(new Event('blur'));
    currentAnchor.remove();
    back();
    expect(document.activeElement?.tagName).toBe('H2');
  } finally {
    clock.mockRestore();
    await ui.close();
  }
});

test('A/B/A sources, locale and viewer retirement fence delayed success and failure without reviving old pages', async () => {
  const ui = await mount();
  let complete!: (read: MusicLocationRead) => void;
  const delayed: MusicLocationTransport = () =>
    new Promise((resolve) => {
      complete = resolve;
    });
  try {
    await ui.render(<MusicLocationReader {...props} transport={delayed} />);
    await ui.click('Next page');
    const old = complete;
    await ui.render(<MusicLocationReader {...props} source={{}} initial={undefined} transport={delayed} />);
    const replaced = complete;
    await ui.render(<MusicLocationReader {...props} initial={{ ok: false, reason: 'stale' }} />);
    await act(async () => {
      old(venue);
      replaced({ ok: false, reason: 'withheld' });
    });
    expect(ui.host.textContent).toContain('The Subject changed');
    expect(ui.host.querySelector('a')).toBeNull();
    await ui.render(<MusicLocationReader {...props} locale="ja" />);
    expect(ui.host.querySelector('a')).toBeNull();
    await ui.render(<MusicLocationReader {...props} source={{}} />);
    expect(ui.host.querySelector('a')).not.toBeNull();
    await act(async () => ui.client.setQueryData(['session'], { state: 'unavailable' }));
    expect(ui.host.querySelector('a')).toBeNull();
  } finally {
    await ui.close();
  }
});
