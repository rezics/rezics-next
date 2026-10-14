'use client';

import { useEffect, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { signInPath } from '../auth/paths.ts';
import { type ReaderActions, ReaderActionsProvider, ShelfButton } from '../catalogue/reader-actions.tsx';
import { createReaderStore, readReaderSeed } from '../catalogue/reader-store.ts';
import { seedServedTypes } from '../catalogue/type-fixtures.ts';
import type { MainClient } from '../discover/types.ts';
import { settle, uuidOf } from '../feed/types.ts';
import { workExperience } from '../entity-page/experience.ts';
import { memoryLibraryApi } from '../library/fixtures.ts';
import { LibraryPage } from '../library/library-page.tsx';
import { messages as libraryMessages } from '../library/messages.ts';
import { readCustomShelfPages, statusShelfRows } from './anime-collection-recorded-page.ts';
import { libraryHref, parseLibraryState, statusShelves } from '../library/state.ts';
import type { LibraryRow, ReadingProgress, ShelfStatus } from '../library/types.ts';
import Link from '../shell/localized-link.tsx';
import { readAnimeAgentCredits, readAnimeReaderState, readAnimeWorkCredits } from '../work-page/anime-hub-recorded-page.ts';
import { booksEditionReads } from '../work-page/books-edition-page.read.ts';
import { WorkCredits } from '../work-page/credits.tsx';
import { messages as workMessages } from '../work-page/messages.ts';
import { workHref } from '../work-page/route.ts';
import { WorkKindActions } from '../work-page/types/actions.tsx';
import { WorkAbout } from '../work-page/work-header.tsx';
import { WorkFrame } from '../work-page/work-frame.tsx';
import { mainMediaApi } from './media-api.ts';
import { SeriesProgressPanel } from './series-progress-panel.tsx';

seedServedTypes();

/** The status-shelf page size the library route's shelf reader asks Main for. */
const SHELF_PAGE = 20;

/** The address Library uses before it reads: signed out, that route redirects here. */
export function librarySignInHref(locale: UiLocale) {
  return signInPath(localizedPath(libraryHref(parseLibraryState({ shelf: 'reading', view: 'grid' })), locale));
}

/** The Work page's signed-out shelf returns here. */
export function workSignInHref(workRef: string, locale: UiLocale) {
  return signInPath(localizedPath(workHref(workRef), locale));
}

type WorkPage = {
  kind: 'work';
  header: Extract<Awaited<ReturnType<ReturnType<typeof booksEditionReads>['readWorkHeader']>>, { ok: true }>['data'];
  agentCredits: Awaited<ReturnType<typeof readAnimeAgentCredits>>;
  credits: Awaited<ReturnType<typeof readAnimeWorkCredits>>;
  seed: Awaited<ReturnType<typeof readAnimeReaderState>>;
  actions: Extract<ReaderActions, { kind: 'ready' }>;
};
type LibraryView = {
  kind: 'library';
  state: ReturnType<typeof parseLibraryState>;
  overview: Parameters<typeof LibraryPage>[0]['overview'];
  view: Parameters<typeof LibraryPage>[0]['view'];
  goal: Parameters<typeof LibraryPage>[0]['goal'];
  stats: Parameters<typeof LibraryPage>[0]['stats'];
  actions: Extract<ReaderActions, { kind: 'ready' }>;
};
type Ready = WorkPage | LibraryView | { kind: 'visitor'; labels: string[] };

/**
 * The library route's shelf, goal and year readers take the session, so a browser cannot call them.
 * This page asks for those same pages through the typed client. Custom shelves use the same
 * page size and cursor walk; status rows use the same mapping as the session reader.
 */
async function loadLibrary(main: MainClient, actingSubject: string): Promise<LibraryView> {
  const state = parseLibraryState({ shelf: 'reading', view: 'grid' });
  const chosen = state.shelf;
  if (chosen.kind !== 'status') throw new Error('The reading shelf is not a status shelf');
  const year = new Date().getUTCFullYear();
  const [shelves, visibility, contexts, goal, stats, shelf] = await Promise.all([
    readCustomShelfPages(main, actingSubject),
    settle(() => main.v1.agents({ id: uuidOf(actingSubject) })['library-visibility'].get()),
    settle(() => main.v1['rating-contexts'].get({ query: { scope: 'global', limit: 1 } })),
    settle(() => main.v1.me['reading-goal'].get({ query: { actingSubject, year } })),
    settle(() => main.v1.me['reading-stats'].get({ query: { actingSubject, year } })),
    settle(() => main.v1.me.shelves.status({ status: chosen.status }).works.get({ query: {
      actingSubject, sort: state.sort, order: state.order, limit: SHELF_PAGE,
    } })),
  ]);
  if (!shelves.ok) throw new Error(shelves.failure);
  if (!shelf.ok) throw new Error(shelf.failure);
  // A further page is a different library view. This visit shows the first page only.
  if (shelves.data.nextCursor) throw new Error('Custom shelves continue');
  if (contexts.ok && contexts.data.nextCursor) throw new Error('Rating contexts continue');
  const items = statusShelfRows(shelf.data.items);
  const [seed, resumes] = await Promise.all([
    readReaderSeed(main, actingSubject, items.map(item => item.work.id)),
    Promise.all(items.map(async item => {
      const resume = await settle(() => main.v1.me.continue({ work: uuidOf(item.work.id) }).get({
        query: { actingSubject } }));
      if (!resume.ok) throw new Error(resume.failure);
      const left = resume.data.unreadCount;
      const progress: ReadingProgress = {
        next: resume.data.nextUnread ? { title: resume.data.nextUnread.title, href: resume.data.nextUnread.href } : null,
        left, chapters: null,
      };
      return [item.work.id, progress] as const;
    })),
  ]);
  if (!seed) throw new Error('reader library denied');
  const progress = new Map(resumes);
  const rows: LibraryRow[] = items.map(item => ({ ...item,
    ...(progress.has(item.work.id) ? { progress: progress.get(item.work.id) } : {}) }));
  const counts = Object.fromEntries(statusShelves.map(status => [status,
    shelves.data.statusShelves.find(item => item.status === status)?.count ?? 0])) as Record<ShelfStatus, number>;
  return {
    kind: 'library', state, goal, stats,
    actions: createReaderStore({ actingSubject, seed, main: () => main }),
    overview: { ok: true, data: { agent: actingSubject, counts, customShelves: shelves.data.items, visibility,
      ratingContext: contexts.ok ? contexts.data.items[0]?.context ?? null : null } },
    view: { ok: true, data: { shelf: chosen, custom: null, total: counts.reading, rows,
      nextCursor: shelf.data.nextCursor, seed } },
  };
}

async function loadWork(main: MainClient, actingSubject: string, work: string): Promise<WorkPage> {
  const id = uuidOf(work);
  const reads = booksEditionReads({ main, actingSubject });
  const [header, seed, agentCredits, credits] = await Promise.all([
    reads.readWorkHeader(id), readAnimeReaderState(main, actingSubject, id),
    readAnimeAgentCredits(main, actingSubject, id), readAnimeWorkCredits(main, actingSubject, id),
  ]);
  if (!header.ok) throw new Error(`Work header: ${header.failure}`);
  return { kind: 'work', header: header.data, seed, agentCredits, credits,
    actions: createReaderStore({ actingSubject, seed: seed ?? {}, main: () => main }) };
}

/**
 * The production Work frame and the production Library page for one recorded visit.
 * A signed-out visit uses the public opening and the sign-in way back to each page.
 * Status changes go through the shelf control; the store is seeded from the reader-state read,
 * so that control does not read it a second time.
 */
export function AnimeCollectionRecordedPage({ persona, actingSubject, main, work, mode, locale }: {
  persona: string; actingSubject?: string; main: MainClient; work: string;
  mode: 'page' | 'library' | 'loading'; locale: UiLocale;
}) {
  const [ready, setReady] = useState<Ready | null>(null);
  const [fault, setFault] = useState<string | null>(null);
  const pageMessages = workMessages[locale];
  const signInHref = workSignInHref(uuidOf(work), locale);
  useEffect(() => {
    setReady(null);
    setFault(null);
    let current = true;
    const fail = (error: unknown) => {
      if (!current || error instanceof DOMException && error.name === 'AbortError') return;
      setFault(error instanceof Error ? error.message : String(error));
    };
    if (mode === 'loading') {
      const pending = actingSubject
        ? booksEditionReads({ main, actingSubject }).readWorkHeader(uuidOf(work))
        : mainMediaApi(undefined as unknown as string, () => main).positions(work);
      void Promise.resolve(pending).catch(fail);
      return () => { current = false; };
    }
    if (mode === 'library' && actingSubject) {
      void loadLibrary(main, actingSubject).then(page => { if (current) setReady(page); }).catch(fail);
      return () => { current = false; };
    }
    if (!actingSubject) {
      void mainMediaApi(undefined as unknown as string, () => main).positions(work).then(opened => {
        if (!current) return;
        if (!opened.ok) { setFault(opened.failure); return; }
        // Episode rows are parts, and this opening keeps chapter positions. The read is the public page.
        setReady({ kind: 'visitor', labels: [] });
      }).catch(fail);
      return () => { current = false; };
    }
    void loadWork(main, actingSubject, work).then(page => { if (current) setReady(page); }).catch(fail);
    return () => { current = false; };
  }, [persona, actingSubject, main, work, mode, locale]);
  const who = <p className="break-all text-muted-foreground text-sm">{persona} · {actingSubject ?? 'none'}</p>;
  if (fault) return <div className="grid min-w-0 gap-2 px-4 py-6">{who}<pre role="alert" className="whitespace-pre-wrap break-words">{fault}</pre></div>;
  if (mode === 'loading' || !ready) {
    return <div className="grid min-w-0 gap-2 px-4 py-6">{who}<p role="status" aria-busy="true">{pageMessages.loading}</p></div>;
  }
  if (ready.kind === 'visitor') {
    return <main className="mx-auto grid min-w-0 max-w-3xl gap-6 px-4 py-6" lang={locale}>
      {who}
      <p className="break-all text-sm">{work}</p>
      {ready.labels.length ? <ul className="grid gap-1 text-sm">{ready.labels.map(label => <li key={label}>{label}</li>)}</ul> : null}
      <ReaderActionsProvider signedIn={false} signInHref={signInHref}>
        <ShelfButton work={work} title={work} locale={locale} size="lg" variant="outline" className="max-w-full" />
      </ReaderActionsProvider>
      <p><Link href={librarySignInHref(locale)}>{libraryMessages.title}</Link></p>
    </main>;
  }
  if (ready.kind === 'library') {
    return <div className="grid min-w-0 gap-3" lang={locale}>
      <div className="px-4 pt-4 sm:px-6">{who}</div>
      <LibraryPage state={ready.state} overview={ready.overview} view={ready.view} reading={[]} goal={ready.goal}
        stats={ready.stats} now={Date.now()} api={memoryLibraryApi()} readerActions={ready.actions} locale={locale}
        messages={libraryMessages} />
    </div>;
  }
  const experience = workExperience(null, ready.header.types);
  return <div className="grid min-w-0 gap-3" lang={locale}>
    <div className="px-4 pt-4 sm:px-6">{who}</div>
    <WorkFrame workRef={uuidOf(work)} work={ready.header} experience={experience} locale={locale} messages={pageMessages}
      signedIn signInHref={signInHref} actingSubject={actingSubject} readerSeed={ready.seed ?? undefined}
      readerActions={ready.actions}
      credits={<WorkCredits agentCredits={ready.agentCredits} credits={ready.credits} locale={locale} messages={pageMessages} />}
      readAction={<WorkKindActions kind={experience.kind} workId={ready.header.id} title={ready.header.title.value}
        locale={locale} messages={pageMessages} />}>
      <WorkAbout work={ready.header} locale={locale} messages={pageMessages} />
      <SeriesProgressPanel work={ready.header.id} locale={locale} preferenceForm={false} />
    </WorkFrame>
  </div>;
}
