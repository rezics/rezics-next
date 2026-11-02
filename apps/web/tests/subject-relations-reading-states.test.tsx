import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import recording from '../src/kernel/recorded/subject-page.json';
import links from '../src/kernel/recorded/subject-links.json';
import * as start from '../.storybook/react-start';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));

test('The mounted standalone Subject Relations page distinguishes failed, empty and populated reading states and keeps its actual native continuation usable without inferring absent relations.', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/subjects/reading/relations' });
  const globals = { window, document: window.document, navigator: window.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  const [
    { createRoot },
    { RelationsView },
    { SubjectFrame, subjectFrame },
    { PendingPage },
    { PlainLink },
    { defaultReader },
    { m },
    { AnonymousSessionContext },
  ] = await Promise.all([
    import('react-dom/client'),
    import('../src/features/pages/relations-view'),
    import('../src/features/pages/subject-frame'),
    import('../src/shell/pending'),
    import('../src/features/pages/shared'),
    import('../src/subject/reader'),
    import('../src/paraglide/messages.js'),
    import('../src/session/query'),
  ]);
  const frame = subjectFrame(recording as never, 'en')!;
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const client = new QueryClient();
  const cursor = 'opaque:/+?=&% 日本語#';
  const base = `/en/subjects/${frame.id}/the-little-prince/relations?property=wdt%3AP155`;
  const definitions = { 'wdt:P155': { label: 'Sequel', group: 'order' as const, symmetric: false } };
  const value = { locale: 'en', link: PlainLink, reader: defaultReader, unlabelled: 'Unlabelled', spoilerShow: 'Show' };
  const render = async (body?: Record<string, unknown>) =>
    act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <AnonymousSessionContext.Provider value>
            {body ? (
              <RelationsView
                locale="en"
                subject={{ id: frame.id, label: frame.title.text }}
                frame={<SubjectFrame frame={frame} locale="en" unlabelled="Unlabelled" view="relations" />}
                data={{ body, property: 'wdt:P155' }}
                relations={definitions}
                value={value}
              />
            ) : (
              <PendingPage />
            )}
          </AnonymousSessionContext.Provider>
        </QueryClientProvider>,
      ),
    );
  try {
    await render();
    expect(host.querySelector('[aria-busy="true"]')?.getAttribute('aria-label')).toBe(m.candidate_loading());
    const rows = links.links.filter((row) => row.property === 'wdt:P155');
    for (const [body, message, count] of [
      [{ links: null, next: cursor }, m.subject_section_failed(), undefined],
      [{ links: [], count: { value: 0, exact: true } }, m.subject_relation_empty_page(), '0'],
      [{ links: [], count: { value: 9, exact: false }, next: cursor }, m.subject_relation_empty_page(), '9+'],
      [{ links: rows, count: { value: 40, exact: true }, next: cursor }, null, '40'],
    ] as const) {
      await render(body);
      expect(host.querySelector('h1')?.textContent).toBe('Sequel');
      expect(host.querySelector('[role="alert"], [role="status"]')?.textContent ?? null).toBe(message);
      expect(host.querySelector('[data-slot="view-heading"] [data-slot="count"]')?.textContent).toBe(count);
      const next = host.querySelector<HTMLAnchorElement>('[data-slot="next-page"]');
      expect(next?.getAttribute('href') ?? null).toBe(
        'next' in body ? `${base}&cursor=${encodeURIComponent(cursor).replaceAll('%20', '+')}` : null,
      );
      expect(host.querySelector('[data-slot="restart-page"]')?.getAttribute('href') ?? null).toBe(
        body.links === null ? base : null,
      );
      expect([...host.querySelectorAll('article')].map((row) => row.textContent)).toEqual(
        body.links === rows ? rows.map((row) => expect.stringContaining(row.label)) : [],
      );
    }
  } finally {
    await act(async () => root.unmount());
    client.clear();
    for (const [key, descriptor] of previous)
      descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key);
    await window.happyDOM.close();
  }
});
