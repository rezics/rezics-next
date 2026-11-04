import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act, createContext, createElement as h, useContext, useRef, useState } from 'react';
import type { SubjectRead } from '@rezics/client';
import type { LinkProps, PageLink } from '../src/features/pages/shared';
import type { ScreenEpisodeEntry, ScreenEpisodeRead } from '../src/features/catalogue/screen-episode-reader/read';
import type { ScreenProfileReader as ScreenProfileReaderComponent } from '../src/features/catalogue/screen-profile-reader';
import type { useScreenEpisodeVisit as ScreenEpisodeVisitHook } from '../src/features/catalogue/screen-episode-reader/visit/owner';
import type { screenEpisodeReturn as ScreenEpisodeReturnFunction } from '../src/features/catalogue/screen-episode-reader/navigation';

mock.module('cloudflare:workers', () => ({ env: {} }));

const seriesId = '00000000-0000-4000-8000-000000000901';
const seasonId = '00000000-0000-4000-8000-000000000902';
const episodeId = '00000000-0000-4000-8000-000000000903';
const retiredEpisodeId = '00000000-0000-4000-8000-000000000904';
const contextId = '00000000-0000-4000-8000-000000000906';
const seriesMembership = '00000000-0000-4000-8000-000000000911';
const episodeMembership = '00000000-0000-4000-8000-000000000912';
const retiredMembership = '00000000-0000-4000-8000-000000000913';
const initialHref = `/en/subjects/${seriesId}/the-observatory?realm=${contextId}&screenCursor=series-window-two`;
const NavigateContext = createContext<(href: string) => void>(() => {});
const observation = { state: 'signed-out' };
let ScreenProfileReader: typeof ScreenProfileReaderComponent;
let useScreenEpisodeVisit: typeof ScreenEpisodeVisitHook;
let screenEpisodeReturn: typeof ScreenEpisodeReturnFunction;

function statement(id: string, parentId: string): NonNullable<ScreenEpisodeEntry['statement']> {
  return {
    id,
    rank: 'normal',
    property: { id: 'schema:isPartOf', data_type: 'wikibase-item' },
    value: { type: 'value', content: parentId },
    qualifiers: [],
    references: [],
    rezics: { release: 'test-release', revision: 1 },
  } as NonNullable<ScreenEpisodeEntry['statement']>;
}

function entry(
  membershipId: string,
  id: string,
  parentId: string,
  type: ScreenEpisodeEntry['type'],
  label: string,
): ScreenEpisodeEntry {
  return {
    membershipId,
    holderId: id,
    parentId,
    context: contextId,
    id,
    type,
    label,
    language: 'en',
    typeLabel: { text: type === 'schema:TVSeason' ? 'TV season' : 'Episode', lang: 'en' },
    statement: statement(membershipId, parentId),
  };
}

const season = entry(seriesMembership, seasonId, seriesId, 'schema:TVSeason', 'Season One');
const episode = entry(episodeMembership, episodeId, seasonId, 'schema:Episode', 'The Observatory Special');
const otherEpisode = entry(retiredMembership, retiredEpisodeId, seasonId, 'schema:Episode', 'Another Episode');

function admitted(entries: ScreenEpisodeEntry[], next: string | null = null): ScreenEpisodeRead {
  return { ok: true, state: 'ready', entries, next };
}

function subject(id: string, type: string): SubjectRead {
  return {
    subject: { id, type, context: contextId, labels: { en: id }, statements: {}, sourceRecords: [] },
    related: {},
    account: null,
    summary: null,
  } as unknown as SubjectRead;
}

function TestLink({ href, lang, className, children }: LinkProps) {
  const navigate = useContext(NavigateContext);
  return (
    <a
      href={href}
      lang={lang}
      className={className}
      onClick={(event) => {
        event.preventDefault();
        navigate(href);
      }}
    >
      {children}
    </a>
  );
}

let changeRoute = (_href: string) => {};
let activeHref = initialHref;
let holdSeasonRead = false;
let retryCursors: string[] = [];

function Journey() {
  const [href, setHref] = useState(initialHref);
  const [retryCount, setRetryCount] = useState(0);
  const generation = useRef(0);
  const lastHref = useRef(href);
  if (lastHref.current !== href) {
    generation.current += 1;
    lastHref.current = href;
  }
  changeRoute = setHref;
  activeHref = href;
  const url = new URL(href, 'https://site.invalid');
  const id = url.pathname.includes(`/${seriesId}/`)
    ? seriesId
    : url.pathname.includes(`/${seasonId}/`)
      ? seasonId
      : url.pathname.includes(`/${episodeId}/`)
        ? episodeId
        : retiredEpisodeId;
  const type = id === seriesId ? 'schema:TVSeries' : id === seasonId ? 'schema:TVSeason' : 'schema:Episode';
  const origin = { pathname: url.pathname, searchStr: url.search, hash: url.hash };
  const cursor = url.searchParams.get('screenCursor');
  let read: ScreenEpisodeRead | undefined;
  if (id === seriesId) {
    if (cursor === 'withdrawn-window') read = { ok: false, reason: 'stale' };
    else if (cursor === 'failed-window' && retryCount === 0) read = { ok: false, reason: 'unavailable' };
    else read = admitted([season]);
  } else if (id === seasonId && !holdSeasonRead) {
    read = cursor === 'season-window-two' ? admitted([episode]) : admitted([otherEpisode], 'season-window-two');
  }
  const sourceKey = JSON.stringify([id, type, contextId, 'en', origin.pathname]);
  const pageKey = `${href}:${generation.current}`;
  const observationCurrent = () => true;
  const visit = useScreenEpisodeVisit({
    sourceKey,
    pageKey,
    origin,
    locale: 'en',
    observation,
    observationCurrent,
    read,
    loading: holdSeasonRead && id === seasonId,
    settledKey: `${retryCount}:${cursor ?? 'first'}`,
    directReturn: screenEpisodeReturn(origin.searchStr, 'en'),
  });
  return h(
    NavigateContext.Provider,
    { value: (next: string) => setHref(next) },
    h('button', { type: 'button', onClick: () => setHref('/en/subjects/00000000-0000-4000-8000-000000000905/elsewhere') }, 'Leave reading'),
    h(ScreenProfileReader, {
      locale: 'en',
      public: subject(id, type),
      ...(read ? { episodeRead: read } : {}),
      episodeLoading: holdSeasonRead && id === seasonId,
      onEpisodeRetry: () => {
        retryCursors.push(cursor ?? 'first');
        setRetryCount((count) => count + 1);
      },
      episodeOrigin: origin,
      episodeVisitKey: pageKey,
      episodeVisit: visit,
      link: TestLink as PageLink,
    }),
  );
}

async function mountedJourney(startHref = initialHref) {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  ScreenProfileReader = (await import('../src/features/catalogue/screen-profile-reader')).ScreenProfileReader;
  useScreenEpisodeVisit = (await import('../src/features/catalogue/screen-episode-reader/visit/owner')).useScreenEpisodeVisit;
  screenEpisodeReturn = (await import('../src/features/catalogue/screen-episode-reader/navigation')).screenEpisodeReturn;
  const window = new Window({ url: `https://site.invalid${startHref}` });
  const keys = [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'HTMLAnchorElement',
    'HTMLButtonElement',
    'Element',
    'Node',
    'Document',
    'IS_REACT_ACT_ENVIRONMENT',
  ];
  const saved = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of keys)
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: key === 'window' ? window : key === 'IS_REACT_ACT_ENVIRONMENT' ? true : window[key as keyof typeof window],
    });
  const { createRoot } = await import('react-dom/client');
  const { setLocale } = await import('../src/paraglide/runtime.js');
  const { m } = await import('../src/paraglide/messages.js');
  const { root, host } = (() => {
    const host = document.createElement('main');
    document.body.append(host);
    return { host, root: createRoot(host) };
  })();
  activeHref = startHref;
  holdSeasonRead = false;
  retryCursors = [];
  changeRoute = () => {};
  setLocale('en', { reload: false });
  await act(async () => root.render(h(Journey)));
  return {
    host,
    m,
    window,
    current: () => activeHref,
    navigate: async (href: string) => act(async () => changeRoute(href)),
    rerender: async () => act(async () => root.render(h(Journey))),
    cleanup: async () => {
      await act(async () => root.unmount());
      window.happyDOM.abort();
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

async function clickText(host: HTMLElement, label: string, window: Window) {
  const node = [...host.querySelectorAll('a,button')].find((candidate) => candidate.textContent?.trim() === label);
  expect(node).toBeTruthy();
  await act(async () => {
    node!.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
  });
}

test('series, season and episode return to the admitted membership and original window', async () => {
  const app = await mountedJourney();
  const { m, host, window } = app;
  try {
    await clickText(host, 'Season One', window);
    const seasonAddress = new URL(app.current(), window.location.origin);
    expect(new URL(seasonAddress.searchParams.get('via')!, window.location.origin).searchParams.get('screenCursor')).toBe(
      'series-window-two',
    );
    await clickText(host, m.screen_episode_reader_continue({}, { locale: 'en' }), window);
    expect(new URL(app.current(), window.location.origin).searchParams.get('screenCursor')).toBe('season-window-two');
    await clickText(host, 'The Observatory Special', window);
    const detailAddress = new URL(app.current(), window.location.origin);
    const returnAddress = new URL(detailAddress.searchParams.get('via')!, window.location.origin);
    expect(returnAddress.pathname).toBe(`/en/subjects/${seasonId}/season-one`);
    expect(returnAddress.searchParams.get('realm')).toBe(contextId);
    expect(returnAddress.searchParams.get('screenCursor')).toBe('season-window-two');
    expect(returnAddress.searchParams.get('screenSelection')).toBe(episodeMembership);
    expect(returnAddress.hash).toBe(`#screen-episode-entry-${episodeMembership}`);
    await clickText(host, m.screen_episode_reader_return({}, { locale: 'en' }), window);
    expect(new URL(app.current(), window.location.origin).pathname).toBe(`/en/subjects/${seasonId}/season-one`);
    expect(new URL(app.current(), window.location.origin).searchParams.get('screenCursor')).toBe('season-window-two');
    expect(document.activeElement?.id).toBe(`screen-episode-entry-${episodeMembership}`);
    await clickText(host, m.screen_episode_reader_return({}, { locale: 'en' }), window);
    const seriesReturn = new URL(app.current(), window.location.origin);
    expect(seriesReturn.pathname).toBe(`/en/subjects/${seriesId}/the-observatory`);
    expect(seriesReturn.searchParams.get('realm')).toBe(contextId);
    expect(seriesReturn.searchParams.get('screenCursor')).toBe('series-window-two');
    expect(seriesReturn.searchParams.get('screenSelection')).toBe(seriesMembership);
    expect(document.activeElement?.id).toBe(`screen-episode-entry-${seriesMembership}`);
  } finally {
    await app.cleanup();
  }
});

test('stale windows restart explicitly, dependency failures retry the exact cursor, and retired membership stays missing', async () => {
  const { m, host, window, current, navigate, cleanup } = await mountedJourney(
    `/en/subjects/${seriesId}/the-observatory?realm=${contextId}&screenCursor=withdrawn-window`,
  );
  try {
    expect(host.textContent).toContain(m.screen_reader_stale({}, { locale: 'en' }));
    await clickText(host, m.screen_episode_reader_start({}, { locale: 'en' }), window);
    const restarted = new URL(current(), window.location.origin);
    expect(restarted.searchParams.has('screenCursor')).toBe(false);
    expect(restarted.searchParams.get('realm')).toBe(contextId);

    await navigate(`/en/subjects/${seriesId}/the-observatory?realm=${contextId}&screenCursor=failed-window`);
    const retry = [...host.querySelectorAll('button')].find((button) => button.textContent === m.correction_retry({}, { locale: 'en' }));
    expect(retry).toBeTruthy();
    await act(async () => retry!.click());
    expect(retryCursors).toEqual(['failed-window']);
    expect(host.querySelector(`#screen-episode-entry-${seriesMembership}`)).toBeTruthy();

    const retiredAddress =
      `/en/subjects/${seriesId}/the-observatory?realm=${contextId}&screenCursor=series-window-two&screenSelection=${retiredMembership}` +
      `#screen-episode-entry-${retiredMembership}`;
    await navigate(retiredAddress);
    expect(host.textContent).toContain(m.screen_episode_reader_selection_missing({}, { locale: 'en' }));
    expect(host.querySelector(`#screen-episode-entry-${retiredMembership}`)).toBeNull();
    expect(host.querySelector('[data-screen-episode-recovery]')).toBeTruthy();
    expect(document.activeElement?.id).not.toBe(`screen-episode-entry-${seriesMembership}`);
  } finally {
    await cleanup();
  }
});

test('a return focus ticket is retired before a later direct visit can reuse it', async () => {
  const app = await mountedJourney();
  const { host, window, m, navigate, rerender, current } = app;
  try {
    await clickText(host, 'Season One', window);
    await clickText(host, m.screen_episode_reader_continue({}, { locale: 'en' }), window);
    await clickText(host, 'The Observatory Special', window);
    const directReturn = new URL(new URL(current(), window.location.origin).searchParams.get('via')!, window.location.origin);
    holdSeasonRead = true;
    await rerender();
    await clickText(host, m.screen_episode_reader_return({}, { locale: 'en' }), window);
    expect(new URL(current(), window.location.origin).searchParams.get('screenSelection')).toBe(episodeMembership);
    await clickText(host, 'Leave reading', window);
    holdSeasonRead = false;
    await navigate(`${directReturn.pathname}${directReturn.search}${directReturn.hash}`);
    expect(host.querySelector(`#screen-episode-entry-${episodeMembership}`)).toBeTruthy();
    expect(document.activeElement?.id).not.toBe(`screen-episode-entry-${episodeMembership}`);
  } finally {
    holdSeasonRead = false;
    await app.cleanup();
  }
});
