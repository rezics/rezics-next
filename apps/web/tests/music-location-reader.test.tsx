import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as start from '../.storybook/react-start';
import {
  musicAreaId,
  musicEventId,
  musicInstrumentId,
  musicLocationExample,
  musicPlaceId,
} from '../src/features/catalogue/music-location-reader/examples';
import type { MusicLocationRead } from '../src/features/catalogue/music-location-reader/model';
import { musicContextKind } from '../src/features/catalogue/music-context-profile';

mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
const { MusicLocationReader } = await import('../src/features/catalogue/music-location-reader/view');

async function ui() {
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
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['session'], { state: 'signed-out' });
  const render = async (props: Parameters<typeof MusicLocationReader>[0]) => {
    await act(async () => {
      root.render(createElement(QueryClientProvider, { client }, createElement(MusicLocationReader, props)));
    });
  };
  const close = async () => {
    await act(async () => root.unmount());
    client.clear();
    host.remove();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await window.happyDOM.close();
  };
  return { host, render, close };
}

test('place, area, event and instrument retain distinct released identity and directed relationship meaning', async () => {
  const place = musicLocationExample('admitted-place');
  expect(musicContextKind(place.release, 'schema:Place')).toBe('place');
  expect(musicContextKind(place.release, 'schema:AdministrativeArea')).toBe('area');
  expect(musicContextKind(place.release, 'schema:Event')).toBe('event');
  expect(musicContextKind(place.release, 'schema:MusicInstrument')).toBe('instrument');

  const area = await place.read({ ...place.address, stream: 'out:schema:containedInPlace' });
  expect(area.ok && area.stream?.direction).toBe('forward');
  expect(area.ok && area.rows[0]?.summary?.id).toBe(musicAreaId);

  const venue = await place.read({ ...place.address, stream: 'in:schema:location' });
  expect(venue.ok && venue.stream?.label.text).toBe('Venue for');
  expect(venue.ok && venue.rows[0]?.summary?.id).toBe(musicEventId);
  expect(venue.ok && venue.rows[0]?.statement?.qualifiers[0]?.value).toEqual({
    type: 'value',
    content: { time: '+2024-05-00T00:00:00Z', precision: 10 },
  });
  expect(venue.ok && venue.rows[0]?.statement?.references[0]?.parts[0]?.value).toEqual({
    type: 'value',
    content: 'https://example.test/event/harbour',
  });
  if (!venue.ok || !venue.next) throw new Error('expected one bounded continuation');
  const nextVenue = await place.read({
    ...place.address,
    stream: venue.stream?.key,
    cursor: venue.next,
    session: venue.session,
  });
  expect(nextVenue.ok && nextVenue.rows[0]?.summary?.label?.value).toBe('River concert');
  expect(nextVenue.ok && nextVenue.next).toBeNull();

  const event = musicLocationExample('admitted-event');
  const instrument = await event.read({ ...event.address, stream: 'out:schema:instrument' });
  expect(instrument.ok && instrument.kind).toBe('event');
  expect(instrument.ok && instrument.rows[0]?.summary?.id).toBe(musicInstrumentId);

  const areaPage = musicLocationExample('admitted-area');
  const areaIdentity = await areaPage.read();
  expect(areaIdentity.ok && areaIdentity.streams.some((stream) => stream.key === 'out:schema:containedInPlace')).toBe(
    true,
  );
  const areaVenue = await areaPage.read({ ...areaPage.address, stream: 'in:schema:containedInPlace' });
  expect(areaVenue.ok && areaVenue.kind).toBe('area');
  expect(areaVenue.ok && areaVenue.rows[0]?.summary?.id).toBe(musicPlaceId);

  const instrumentPage = musicLocationExample('admitted-instrument');
  const eventLink = await instrumentPage.read({ ...instrumentPage.address, stream: 'in:schema:instrument' });
  expect(eventLink.ok && eventLink.kind).toBe('instrument');
  expect(eventLink.ok && eventLink.rows[0]?.summary?.id).toBe(musicEventId);
});

test('sparse, unsupported, hidden and retired observations never invent destinations or missing facts', async () => {
  const sparse = await musicLocationExample('sparse').read();
  expect(sparse.ok && sparse.kind).toBe('place');
  expect(sparse.ok && sparse.streams.length).toBeGreaterThan(0);
  expect(sparse.ok && sparse.rows).toEqual([]);

  const unsupported = await musicLocationExample('unsupported').read();
  expect(unsupported.ok && unsupported.kind).toBe('unsupported');
  expect(unsupported.ok && unsupported.streams).toEqual([]);

  const hiddenFixture = musicLocationExample('hidden-target');
  const hidden = await hiddenFixture.read({ ...hiddenFixture.address, stream: 'in:schema:location' });
  expect(hidden.ok && hidden.rows).toEqual([]);

  const retired = await musicLocationExample('retired').read();
  expect(retired).toEqual({ ok: false, reason: 'stale' });
});

test('exact disclosed destinations open in the route locale and return focus to their source relation', async () => {
  const fixture = musicLocationExample('admitted-place');
  const initial = await fixture.read({ ...fixture.address, stream: 'in:schema:location' });
  if (!initial.ok) throw new Error('expected admitted venue relationship');
  const mounted = await ui();
  try {
    await mounted.render({
      subject: fixture.public,
      context: fixture.address.context,
      source: fixture.source,
      reader: null,
      locale: 'en',
      transport: fixture.read,
      initial,
    });
    const target = mounted.host.querySelector<HTMLAnchorElement>(`a[href*="${musicEventId}"]`);
    expect(target).not.toBeNull();
    expect(target?.href).toContain('/en/subjects/');
    expect(target?.target).toBe('_blank');
    expect(target?.rel).toBe('noopener');
    expect(mounted.host.textContent).toContain('Venue for');
    expect(mounted.host.textContent).toContain('2024');
    target!.focus();
    target!.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    window.dispatchEvent(new Event('blur'));
    target!.blur();
    window.dispatchEvent(new Event('focus'));
    expect(document.activeElement).toBe(target);
  } finally {
    await mounted.close();
  }
});

test('a replaced Subject observation cannot restore a delayed relationship window', async () => {
  const fixture = musicLocationExample('admitted-place');
  const initial = await fixture.read({ ...fixture.address, stream: 'in:schema:location' });
  if (!initial.ok) throw new Error('expected admitted venue relationship');
  let finish!: (value: MusicLocationRead) => void;
  const delayed = new Promise<MusicLocationRead>((resolve) => {
    finish = resolve;
  });
  const mounted = await ui();
  try {
    const source = {};
    let requests = 0;
    const props = {
      subject: fixture.public,
      context: fixture.address.context,
      source,
      reader: null,
      locale: 'en',
      transport: () => (++requests === 1 ? delayed : Promise.resolve({ ok: false, reason: 'stale' } as const)),
    };
    await mounted.render(props);
    await mounted.render({
      ...props,
      source: {},
      subject: {
        ...fixture.public,
        subject: { ...fixture.public.subject, revision: fixture.public.subject.revision + 1 },
      },
    });
    await act(async () => finish(initial));
    expect(mounted.host.querySelector(`[href*="${musicEventId}"]`)).toBeNull();
  } finally {
    await mounted.close();
  }
});

test('bounded native reads preserve withheld forward rows, original occurrence identity and session chaining', async () => {
  const { createKernelClient } = await import('@rezics/client');
  const { readMusicLocation } = await import('../src/features/catalogue/music-location-reader/model');
  const fixture = musicLocationExample('admitted-place');
  const calls: { path: string; session: string | null }[] = [];
  let oversize = false;
  const boundedFetch: typeof fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      calls.push({ path: url.pathname, session: request.headers.get('rezics-session-token') });
      const subject = !url.pathname.endsWith('/relations');
      return new Response(
        JSON.stringify(
          subject
            ? fixture.public
            : {
                relations: [
                  {
                    statement: fixture.areaRelation,
                    target: musicAreaId,
                    external: null,
                    summary: null,
                    related: {},
                    ...(oversize ? { padding: 'x'.repeat(128 * 1024) } : {}),
                  },
                ],
                freshness: { consistency: 'eventual', target_seconds: 10, caught_up: true },
                next: null,
              },
        ),
        {
          headers: {
            'content-type': 'application/json',
            'rezics-session-token': subject ? 'subject-session' : 'page-session',
          },
        },
      );
    },
    { preconnect: fetch.preconnect },
  );
  const client = createKernelClient('https://bounded.example', { fetch: boundedFetch });
  const address = { ...fixture.address, stream: 'out:schema:containedInPlace', session: 'original-session' };
  const page = await readMusicLocation(client, undefined, fixture.release, address, 'en');
  expect(page.ok && page.session).toBe('page-session');
  expect(calls).toHaveLength(2);
  expect(calls.map((call) => call.session)).toEqual(['original-session', 'subject-session']);
  expect(page.ok && page.rows[0]?.holder).toBe(fixture.address.id);
  expect(page.ok && page.rows[0]?.statementId).toBe(fixture.areaRelation.id);
  expect(page.ok && page.rows[0]?.summary).toBeNull();
  if (!page.ok) throw new Error('expected a withheld endpoint with readable assertion');
  const mounted = await ui();
  try {
    await mounted.render({
      subject: fixture.public,
      context: fixture.address.context,
      source: fixture.source,
      reader: null,
      locale: 'en',
      transport: fixture.read,
      initial: page,
    });
    expect(mounted.host.querySelector('a[target="_blank"]')).toBeNull();
    expect(mounted.host.querySelector('[data-slot="music-location-row"]')).not.toBeNull();
  } finally {
    await mounted.close();
  }
  oversize = true;
  expect(await readMusicLocation(client, undefined, fixture.release, address, 'en')).toEqual({
    ok: false,
    reason: 'unavailable',
  });
  const before = calls.length;
  expect(
    await readMusicLocation(client, undefined, fixture.release, { ...address, cursor: 'x'.repeat(4097) }, 'en'),
  ).toEqual({ ok: false, reason: 'invalid' });
  expect(calls).toHaveLength(before);
});
