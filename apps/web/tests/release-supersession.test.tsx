import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import { bundledRelease, bundledDigest } from '@rezics/definitions/bundled';
import { dateReading, releaseGroups, releaseStreams } from '../src/features/catalogue/release-fidelity/model';
import { candidateContext } from '../src/subject/candidates';
import { releaseFidelityFixture } from '../src/kernel/fake/release-fidelity';

import * as start from '../.storybook/react-start';

mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);

const statement = (content: unknown) => [
  {
    id: '00000000-0000-4000-8000-000000000114',
    rank: 'normal' as const,
    property: { id: 'schema:datePublished', data_type: 'time' as const },
    value: { type: 'value' as const, content },
    qualifiers: [],
    references: [],
    rezics: { release: bundledDigest, revision: 1 },
  },
];

test('release dates keep TBA, concrete failures, signed years, extended years and native precision separate', () => {
  expect(dateReading([{ ...statement(null)[0]!, value: { type: 'somevalue' } }], 'schema:datePublished', bundledDigest, 'en'))
    .toMatchObject({ kind: 'tba' });
  expect(
    dateReading(
      statement({ time: '-0001-00-00T00:00:00Z', precision: 9 }),
      'schema:datePublished',
      bundledDigest,
      'en',
    ),
  ).toMatchObject({ kind: 'partial', precision: 'year', text: '-0001' });
  expect(
    dateReading(
      statement({ time: '+12000-00-00T00:00:00Z', precision: 9 }),
      'schema:datePublished',
      bundledDigest,
      'en',
    ),
  ).toMatchObject({ kind: 'partial', precision: 'year', text: '12000' });
  expect(
    dateReading(
      statement({ time: '+2004-10-00T00:00:00Z', precision: 10 }),
      'schema:datePublished',
      bundledDigest,
      'en',
    ),
  ).toMatchObject({ kind: 'partial', precision: 'month' });
  expect(
    dateReading(
      statement({ time: '+2004-02-30T00:00:00Z', precision: 11 }),
      'schema:datePublished',
      bundledDigest,
      'en',
    ),
  ).toMatchObject({ kind: 'invalid', statementId: expect.any(String) });
  expect(
    dateReading(
      statement({ time: '+2004-10-15T00:00:00Z', precision: 8 }),
      'schema:datePublished',
      bundledDigest,
      'en',
    ),
  ).toMatchObject({ kind: 'unsupported', statementId: expect.any(String) });
  expect(
    dateReading(
      statement({ time: '+2004-10-00T00:00:00Z', precision: 11 }),
      'schema:datePublished',
      bundledDigest,
      'en',
    ),
  ).toMatchObject({ kind: 'invalid' });
  expect(
    dateReading(
      statement({ time: '+2004-10-15T99:00:00Z', precision: 11 }),
      'schema:datePublished',
      bundledDigest,
      'en',
    ),
  ).toMatchObject({ kind: 'invalid' });
  expect(
    dateReading(
      statement({ time: '+2004-10-00T00:00:00Z', precision: 10, calendarmodel: 'http://example.test/calendar' }),
      'schema:datePublished',
      bundledDigest,
      'en',
    ),
  ).toMatchObject({ kind: 'unsupported' });
});

test('the released release visit offers exact forward supersession and its inverse disclosure', () => {
  const streams = releaseStreams(bundledRelease, 'wd:Q20631656', 'en');
  expect(streams).toContainEqual(
    expect.objectContaining({
      key: 'forward:rezics:releaseSupersedes',
      property: 'rezics:releaseSupersedes',
      direction: 'forward',
      label: { text: 'supersedes', lang: 'en' },
    }),
  );
  expect(streams).toContainEqual(
    expect.objectContaining({
      key: 'inverse:rezics:releaseSupersedes',
      property: 'rezics:releaseSupersedes',
      direction: 'inverse',
      label: { text: 'Superseded by', lang: 'en' },
    }),
  );
});

test('mounted release visit labels an invalid date with evidence and keeps chronology separate', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/subjects/release/release' });
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
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    matchMedia: window.matchMedia.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { ReleaseFidelityPage } = await import('../src/features/catalogue/release-fidelity/view');
  const fixture = releaseFidelityFixture('ready');
  const result = await fixture.read();
  if (!result.ok) throw new Error('Expected a released page snapshot');
  const read = structuredClone(result);
  const type = 'wd:Q20631656';
  read.public.subject.type = type;
  const date = read.public.subject.statements['schema:datePublished']![0]!;
  date.value = {
    type: 'value',
    content: { time: '+2004-02-30T00:00:00Z', precision: 11, calendarmodel: 'http://www.wikidata.org/entity/Q1985727' },
  };
  read.date = dateReading([date], 'schema:datePublished', read.digest, 'en');
  read.groups = releaseGroups(read.release, type);
  read.streams = releaseStreams(read.release, type, 'en');
  read.stream = read.streams.find((stream) => stream.key === 'forward:rezics:releaseSupersedes');
  read.streamState = 'empty';
  read.rows = [];
  read.next = null;

  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { m } = await import('../src/paraglide/messages.js');
  try {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <ReleaseFidelityPage
            id={read.public.subject.id}
            context={candidateContext}
            locale="en"
            search={async () => []}
            transport={{
              read: async () => read,
              facts: { read: async () => ({ ok: false, reason: 'denied' }), propose: async () => ({ ok: false }) } as never,
              relation: () => ({}) as never,
              review: () => ({}) as never,
            }}
          />
        </QueryClientProvider>,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.textContent).toContain(m.release_fidelity_date_invalid({}, { locale: 'en' }));
    expect(host.querySelector('[data-slot="release-date"] details')).not.toBeNull();
    expect(host.textContent).toContain('2004-02-30T00:00:00Z');
    expect([...host.querySelectorAll('option')].map((option) => option.textContent)).toEqual(
      expect.arrayContaining(['follows', 'supersedes', 'Superseded by']),
    );
    expect(host.textContent).not.toContain(m.release_fidelity_date_tba({}, { locale: 'en' }));
  } finally {
    await act(async () => root.unmount());
    client.clear();
    host.remove();
    window.happyDOM.abort();
    for (const [key, descriptor] of previous)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
  }
});
