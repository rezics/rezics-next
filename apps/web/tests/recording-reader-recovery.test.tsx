import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SubjectRead } from '@rezics/client';
import type { Release } from '@rezics/definitions';
import type { RecordingReleaseRead } from '../src/features/catalogue/recording-reader/read';
import type { RecordingReleaseLoader } from '../src/features/catalogue/recording-reader/review/release';
import { albumFixture, albumId, artistId, seriesId } from '../src/kernel/fake/catalogue-album-profile';
import { recordingType } from '../src/features/catalogue/recording-reader/model';
import { connectionReturnHref } from '../src/features/pages/subject-visit-navigation';
import { candidateContext } from '../src/subject/candidates';
import { sessionQueryKey } from '../src/session/browser-state';

mock.module('cloudflare:workers', () => ({ env: {} }));

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: `https://rezics.test/en/subjects/${albumId}/harbour-recording` });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLButtonElement: window.HTMLButtonElement,
  Element: window.Element,
  Node: window.Node,
  Document: window.Document,
  DocumentFragment: window.DocumentFragment,
  MutationObserver: window.MutationObserver,
  Event: window.Event,
  MouseEvent: window.MouseEvent,
  KeyboardEvent: window.KeyboardEvent,
  FocusEvent: window.FocusEvent,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

const [{ createRoot }, { RecordingOverview }, { m }] = await Promise.all([
  import('react-dom/client'),
  import('../src/features/catalogue/recording-reader/overview'),
  import('../src/paraglide/messages.js'),
]);

const realmId = '00000000-0000-4000-8000-00000000a109';
const context = { id: realmId, population: { kind: 'realm' as const, id: realmId, title: 'Example realm' } };

function recordingFixture() {
  const value = albumFixture('ready', 'en');
  value.publicRead.subject.type = recordingType;
  const album = value.release.types['schema:MusicAlbum'];
  if (!album) throw new Error('The fixture release has no album definition');
  value.release.types[recordingType] = {
    ...structuredClone(album),
    bases: ['schema:Thing'],
    labels: { en: 'recording' },
    properties: ['schema:contributor', 'schema:datePublished'],
  };
  return value;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

function unavailable(): RecordingReleaseRead {
  return { ok: false, reason: 'unavailable' };
}

function releaseRead(digest: string, release: Release): RecordingReleaseRead {
  return { ok: true, digest, release };
}

function labeledRelease(release: Release, label: string): Release {
  const next = structuredClone(release);
  next.types[recordingType]!.labels = { en: label };
  return next;
}

async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 40));
}

function currentAddress(returnTo: string) {
  return `/en/subjects/${albumId}/harbour-recording?realm=${realmId}&via=${encodeURIComponent(returnTo)}`;
}

async function mount(initial: {
  read: SubjectRead;
  currentHref: string;
  returnTo: string;
  locale?: string;
  loadRelease: RecordingReleaseLoader;
}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: Infinity } } });
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  let props = initial;
  let closed = false;
  const render = async (next?: Partial<typeof initial>) => {
    if (next) props = { ...props, ...next };
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <RecordingOverview
            locale={props.locale ?? 'en'}
            public={props.read}
            context={context}
            returnTo={props.returnTo}
            currentHref={props.currentHref}
            loadRelease={props.loadRelease}
          />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await tick();
    });
  };
  await render();
  return {
    host,
    client,
    render,
    close: async () => {
      if (closed) return;
      closed = true;
      await act(async () => root.unmount());
      client.clear();
      host.remove();
    },
  };
}

function button(host: HTMLElement, name: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((item) => item.textContent?.trim() === name);
  if (!found) throw new Error(`Missing button: ${name}`);
  return found;
}

async function activateByKeyboard(target: HTMLElement) {
  target.focus();
  await act(async () => {
    target.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    target.dispatchEvent(new window.MouseEvent('click', { bubbles: true, detail: 0 }));
    await tick();
  });
}

test('a failed release can be retried deliberately before exact fact and source inspection', async () => {
  const fixture = recordingFixture();
  const digest = fixture.publicRead.subject.release;
  const outer = connectionReturnHref(seriesId, 'Harbour concerts', 'en');
  const calls: string[] = [];
  const loadRelease: RecordingReleaseLoader = async (requested) => {
    calls.push(requested);
    return calls.length === 2 ? releaseRead(requested, fixture.release) : unavailable();
  };
  const view = await mount({
    read: fixture.publicRead,
    currentHref: currentAddress(outer),
    returnTo: outer,
    loadRelease,
  });
  try {
    expect(view.host.querySelector('[role="alert"]')?.textContent).toContain(
      m.recording_reader_unavailable({}, { locale: 'en' }),
    );
    expect(view.host.textContent).toContain(m.subject_details({}, { locale: 'en' }));
    expect(view.host.textContent).toContain(m.subject_relations({}, { locale: 'en' }));

    await activateByKeyboard(button(view.host, m.recording_reader_retry({}, { locale: 'en' })));
    expect(calls).toEqual([digest, digest]);
    const readerHeading = [...view.host.querySelectorAll('h2')].find((item) => item.textContent === 'recording');
    expect(readerHeading).toBeDefined();
    expect(document.activeElement).toBe(readerHeading);

    const fact = fixture.publicRead.subject.statements['schema:contributor']![0]!;
    const statement = view.host.querySelector<HTMLElement>(`[data-recording-statement="${fact.id}"]`)!;
    expect(statement.textContent).toContain('The Harbour Ensemble');
    expect(statement.textContent).toContain('Performer');
    const target = new URL(statement.querySelector<HTMLAnchorElement>(`a[href*="/subjects/${artistId}/"]`)!.href);
    expect(target.searchParams.get('realm')).toBe(realmId);
    const returned = new URL(target.searchParams.get('via')!, 'https://rezics.test');
    expect(returned.pathname).toBe(`/en/subjects/${albumId}/harbour-recording`);
    expect(returned.searchParams.get('realm')).toBe(realmId);
    expect(returned.searchParams.get('via')).toBe(outer);
    expect(returned.hash).toBe(`#recording-statement-${fact.id}`);

    const opener = statement.querySelector('button')!;
    await activateByKeyboard(opener);
    const inspection = view.host.querySelector<HTMLElement>('#recording-fact-inspection')!;
    expect(document.activeElement).toBe(opener);
    expect(opener.nextElementSibling).toBe(inspection);
    expect(inspection.textContent).toContain('The Harbour Ensemble');
    expect(inspection.textContent).toContain('Performer');
    const source = new URL(inspection.querySelector<HTMLAnchorElement>('a[href*="/value?"]')!.href);
    expect(source.searchParams.get('statement')).toBe(fact.id);
    expect(source.searchParams.get('property')).toBe('schema:contributor');
    expect(source.searchParams.get('context')).toBe(candidateContext);
    expect(source.searchParams.get('via')).toBe(target.searchParams.get('via'));
    await view.render({ currentHref: source.searchParams.get('via')! });
    expect(statement.querySelector('#recording-fact-inspection')).not.toBeNull();
    expect(document.activeElement).toBe(opener);
    await view.render({ read: structuredClone(fixture.publicRead) });
    expect(view.host.querySelector('#recording-fact-inspection')).toBeNull();
    await activateByKeyboard(button(view.host, m.recording_reader_retry({}, { locale: 'en' })));
    expect(view.host.querySelector('[role="alert"]')?.textContent).toContain(
      m.recording_reader_unavailable({}, { locale: 'en' }),
    );
    expect(view.host.textContent).not.toContain(m.recording_reader_fact_retired({}, { locale: 'en' }));
  } finally {
    await view.close();
  }
});

test('every group keeps one local exact statement, ordinary pointer focus and live no-scroll close/return', async () => {
  const fixture = recordingFixture();
  fixture.release.types[recordingType]!.properties.push('wdt:P179');
  const credits = fixture.publicRead.subject.statements['schema:contributor']!;
  const duplicate = { ...structuredClone(credits[0]!), id: '123e4567-e89b-42d3-a456-426614174001' };
  credits.push(duplicate);
  const outer = connectionReturnHref(seriesId, 'Harbour concerts', 'en');
  const view = await mount({
    read: fixture.publicRead,
    currentHref: currentAddress(outer),
    returnTo: outer,
    loadRelease: async (digest) => releaseRead(digest, fixture.release),
  });
  const away = window.document.createElement('button');
  window.document.body.append(away);
  try {
    for (const property of ['schema:datePublished', 'schema:contributor', 'wdt:P179']) {
      const id = fixture.publicRead.subject.statements[property]![0]!.id;
      const row = view.host.querySelector<HTMLElement>(`[data-recording-statement="${id}"]`)!;
      const opener = row.querySelector('button')!;
      away.focus();
      await act(async () => {
        opener.dispatchEvent(new window.MouseEvent('click', { bubbles: true, detail: 1 }));
      });
      expect(document.activeElement).toBe(away);
      const inspection = row.querySelector<HTMLElement>('#recording-fact-inspection')!;
      expect(opener.nextElementSibling).toBe(inspection);
      expect(view.host.querySelectorAll('#recording-fact-inspection')).toHaveLength(1);
      const close = inspection.querySelector('button')!;
      expect(inspection.querySelector('button, a')).toBe(close);
      const focus = mock(opener.focus.bind(opener));
      opener.focus = focus;
      await activateByKeyboard(close);
      expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
      expect(document.activeElement).toBe(opener);
      await activateByKeyboard(opener);
      await act(async () => {
        opener.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
      expect(row.querySelector('#recording-fact-inspection')).toBeNull();
      expect(document.activeElement).toBe(opener);
    }
    const row = view.host.querySelector<HTMLElement>(`[data-recording-statement="${duplicate.id}"]`)!;
    const opener = row.querySelector('button')!;
    await activateByKeyboard(opener);
    const inspection = row.querySelector<HTMLElement>('#recording-fact-inspection')!;
    const related = new URL(inspection.querySelector<HTMLAnchorElement>(`a[href*="/subjects/${artistId}/"]`)!.href);
    expect(related.searchParams.get('via')).toContain(`#recording-statement-${duplicate.id}`);
    away.focus();
    await act(async () => {
      inspection.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.activeElement).toBe(opener);
    opener.blur();
    await view.render({ currentHref: related.searchParams.get('via')! });
    expect(document.activeElement).toBe(row);
    expect(row.querySelector('#recording-fact-inspection')).not.toBeNull();
    const next = structuredClone(fixture.publicRead);
    next.subject.statements['schema:contributor'] = [credits[0]!];
    await view.render({ read: next });
    expect(view.host.querySelector('#recording-fact-inspection')).toBeNull();
    expect(document.activeElement).not.toBe(opener);
    await view.render({ currentHref: currentAddress(outer) });
    await view.render({ currentHref: related.searchParams.get('via')! });
    expect(view.host.textContent).toContain(m.recording_reader_fact_retired({}, { locale: 'en' }));
    expect(view.host.querySelector('#recording-fact-inspection')).toBeNull();
    await activateByKeyboard(button(view.host, m.recording_reader_restart({}, { locale: 'en' })));
    expect(view.host.textContent).not.toContain(m.recording_reader_fact_retired({}, { locale: 'en' }));
    const survivor = view.host.querySelector<HTMLButtonElement>('[data-recording-statement] button')!;
    await activateByKeyboard(survivor);
    await view.render({ locale: 'zh-Hans', currentHref: `/zh-Hans/subjects/${albumId}/harbour-recording` });
    expect(view.host.querySelector('#recording-fact-inspection')).toBeNull();
    expect(document.activeElement).not.toBe(survivor);
    const current = view.host.querySelector<HTMLButtonElement>('[data-recording-statement] button')!;
    await activateByKeyboard(current);
    const focus = mock(current.focus.bind(current));
    current.focus = focus;
    await view.close();
    expect(focus).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(current);
  } finally {
    await view.close();
    away.remove();
  }
});

test('viewer and credential replacement retire pending retry and selected fact without restoring stale bodies', async () => {
  const fixture = recordingFixture();
  const digest = fixture.publicRead.subject.release;
  const outer = connectionReturnHref(seriesId, 'Harbour concerts', 'en');
  const stale = deferred<RecordingReleaseRead>();
  let calls = 0;
  const loadRelease: RecordingReleaseLoader = async (requested) => {
    calls += 1;
    if (calls === 1) return unavailable();
    if (calls === 2) return stale.promise;
    return releaseRead(requested, fixture.release);
  };
  const view = await mount({
    read: fixture.publicRead,
    currentHref: currentAddress(outer),
    returnTo: outer,
    loadRelease,
  });
  const away = window.document.createElement('button');
  away.textContent = 'Elsewhere';
  window.document.body.append(away);
  try {
    await act(async () => {
      view.client.setQueryData(sessionQueryKey, { state: 'signed-in', subject: 'viewer-a', csrfToken: 'credential-a' });
      await tick();
    });
    await activateByKeyboard(button(view.host, m.recording_reader_retry({}, { locale: 'en' })));
    away.focus();
    await act(async () => {
      view.client.setQueryData(sessionQueryKey, { state: 'signed-in', subject: 'viewer-a', csrfToken: 'credential-b' });
      await tick();
    });
    expect(document.activeElement).toBe(away);
    expect(view.host.querySelector('button')?.textContent).toBe(m.recording_reader_retry({}, { locale: 'en' }));

    stale.resolve(releaseRead(digest, labeledRelease(fixture.release, 'Stale release')));
    await act(async () => tick());
    expect(view.host.textContent).not.toContain('Stale release');
    expect(view.host.querySelector('button')?.textContent).toBe(m.recording_reader_retry({}, { locale: 'en' }));

    await activateByKeyboard(button(view.host, m.recording_reader_retry({}, { locale: 'en' })));
    expect(calls).toBe(3);
    const fact = fixture.publicRead.subject.statements['schema:contributor']![0]!;
    const row = view.host.querySelector<HTMLElement>(`[data-recording-statement="${fact.id}"]`)!;
    await activateByKeyboard(row.querySelector('button')!);
    expect(view.host.querySelector('#recording-fact-inspection')).not.toBeNull();

    await act(async () => {
      view.client.setQueryData(sessionQueryKey, { state: 'signed-in', subject: 'viewer-a', csrfToken: 'credential-c' });
      await tick();
    });
    expect(view.host.querySelector('#recording-fact-inspection')).toBeNull();
    expect(view.host.textContent).not.toContain('The Harbour Ensemble');
    expect(view.host.querySelector('button')?.textContent).toBe(m.recording_reader_retry({}, { locale: 'en' }));
    await activateByKeyboard(button(view.host, m.recording_reader_retry({}, { locale: 'en' })));
    expect(view.host.querySelector('[data-recording-statement]')).not.toBeNull();
    expect(view.host.querySelector('#recording-fact-inspection')).toBeNull();
  } finally {
    await view.close();
    away.remove();
  }
});

test('A/B/A source and release retirement rejects a late attempt and retries only the current release', async () => {
  const fixture = recordingFixture();
  const digestA = fixture.publicRead.subject.release;
  const digestB = `sha256:${'b'.repeat(64)}`;
  const readA = fixture.publicRead;
  const readB = structuredClone(readA);
  readB.subject.release = digestB;
  readB.subject.revision += 1;
  const releaseAStale = labeledRelease(fixture.release, 'Stale A release');
  const releaseACurrent = labeledRelease(fixture.release, 'Current A recording');
  const releaseB = labeledRelease(fixture.release, 'Current B recording');
  const stale = deferred<RecordingReleaseRead>();
  let callsA = 0;
  let callsB = 0;
  const loadRelease: RecordingReleaseLoader = async (requested) => {
    if (requested === digestA) {
      callsA += 1;
      if (callsA === 1) return unavailable();
      if (callsA === 2) return stale.promise;
      return releaseRead(requested, releaseACurrent);
    }
    callsB += 1;
    return callsB === 1 ? unavailable() : releaseRead(requested, releaseB);
  };
  const outer = connectionReturnHref(seriesId, 'Harbour concerts', 'en');
  const view = await mount({
    read: readA,
    currentHref: currentAddress(outer),
    returnTo: outer,
    loadRelease,
  });
  try {
    await activateByKeyboard(button(view.host, m.recording_reader_retry({}, { locale: 'en' })));
    expect(callsA).toBe(2);
    await view.render({ read: readB, currentHref: currentAddress(outer) });
    expect(view.host.querySelector('[role="alert"]')?.textContent).toContain(
      m.recording_reader_unavailable({}, { locale: 'en' }),
    );
    expect(callsB).toBe(1);

    await activateByKeyboard(button(view.host, m.recording_reader_retry({}, { locale: 'en' })));
    expect(view.host.querySelector('h2')?.textContent).toBe('Current B recording');
    await view.render({ read: readA, currentHref: currentAddress(outer) });
    expect(view.host.querySelector('h2')?.textContent).toBe('Current A recording');

    stale.resolve(releaseRead(digestA, releaseAStale));
    await act(async () => tick());
    expect(view.host.querySelector('h2')?.textContent).toBe('Current A recording');
    expect(view.host.textContent).not.toContain('Stale A release');
    expect(callsA).toBe(3);
    expect(callsB).toBe(2);
  } finally {
    await view.close();
  }
});
