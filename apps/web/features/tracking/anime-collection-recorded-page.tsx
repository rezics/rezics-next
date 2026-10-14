'use client';

import { materializeData } from 'native-i18n';
import { useEffect, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { signInPath } from '../auth/paths.ts';
import { type ReaderActions, ReaderActionsProvider, ShelfButton } from '../catalogue/reader-actions.tsx';
import { createReaderStore, readReaderSeed } from '../catalogue/reader-store.ts';
import type { MainClient } from '../discover/types.ts';
import { messages as libraryMessages } from '../library/messages.ts';
import { libraryHref, parseLibraryState } from '../library/state.ts';
import Link from '../shell/localized-link.tsx';
import { messages as workMessages } from '../work-page/messages.ts';
import { workHref } from '../work-page/route.ts';
import { mainTrackingApi } from './api.ts';
import { mainEpisodeApi } from './episode-api.ts';
import { EpisodeProgress } from './episode-progress.tsx';
import { mainMediaApi } from './media-api.ts';
import { copyOf } from './messages.ts';

/** The address Library uses before it reads: signed out, that route redirects here. */
export function librarySignInHref(locale: UiLocale) {
  return signInPath(localizedPath(libraryHref(parseLibraryState({ shelf: 'reading', view: 'grid' })), locale));
}

/** The Work page's signed-out shelf returns here. */
export function workSignInHref(workRef: string, locale: UiLocale) {
  return signInPath(localizedPath(workHref(workRef), locale));
}

/**
 * Public episode opening, the shelf control and the episode inventory.
 * The status write runs before the shelf button asks for reader state: that
 * button's own read would satisfy the store and skip the compare-and-set read.
 */
export function AnimeCollectionRecordedPage({ persona, actingSubject, main, work, mode, locale }: {
  persona: string; actingSubject?: string; main: MainClient; work: string;
  mode: 'tracking' | 'watched' | 'loading'; locale: UiLocale;
}) {
  const [actions, setActions] = useState<ReaderActions | null>(null);
  const [fault, setFault] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const loading = materializeData(workMessages[locale], { locale }).loading;
  const signInHref = workSignInHref(work.slice(-36), locale);
  useEffect(() => {
    setActions(null);
    setFault(null);
    setReady(false);
    let current = true;
    const fail = (error: unknown) => {
      if (!current || error instanceof DOMException && error.name === 'AbortError') return;
      setFault(error instanceof Error ? error.message : String(error));
    };
    const media = mainMediaApi(actingSubject as string, () => main);
    if (mode === 'loading') {
      void media.positions(work).catch(error => {
        if (current && !(error instanceof DOMException && error.name === 'AbortError')) fail(error);
      });
      return () => { current = false; };
    }
    void (async () => {
      const opened = await media.positions(work);
      if (!current) return;
      if (!opened.ok) { setFault(opened.failure); return; }
      if (!actingSubject) { setReady(true); return; }
      const seed = await readReaderSeed(main, actingSubject, [work]);
      if (!current) return;
      if (!seed) { setFault('reader library denied'); return; }
      const store = createReaderStore({ actingSubject, main: () => main });
      const saved = await store.setStatus(work, 'reading');
      if (!current) return;
      if (!saved) { setFault('reader status was not saved'); return; }
      const tracking = mainTrackingApi(actingSubject, () => main);
      // `readCustomShelves` is the server reader of this page. It imports the session, so the
      // client seam asks for the same first page (`limit` 20) and the unit calls that reader.
      const [shelves, attempts, editions, preference, relations, series] = await Promise.all([
        main.v1.me.shelves.get({ query: { actingSubject, limit: 20 } }),
        tracking.sessions(work),
        tracking.editions(work),
        tracking.preference(work),
        tracking.relations(work),
        tracking.series(work, locale),
      ]);
      const equivalent = await tracking.definition('correspondence-equivalent');
      if (!current) return;
      if (shelves.error) { setFault('shelves'); return; }
      for (const read of [attempts, editions, preference, relations, series]) {
        if (!read.ok && read.failure !== 'missing') { setFault(read.failure); return; }
      }
      if (!equivalent.ok && equivalent.failure !== 'missing') { setFault(equivalent.failure); return; }
      setActions(store);
      setReady(true);
    })().catch(fail);
    return () => { current = false; };
  }, [persona, actingSubject, main, work, mode, locale]);
  const who = <p className="break-all text-muted-foreground text-sm">{persona} · {actingSubject ?? 'none'}</p>;
  if (fault) return <div className="grid min-w-0 gap-2 px-4 py-6">{who}<pre role="alert" className="whitespace-pre-wrap break-words">{fault}</pre></div>;
  return <main className="mx-auto grid min-w-0 max-w-3xl gap-6 px-4 py-6" lang={locale}>
    {who}
    <p className="break-all text-sm">{work}</p>
    {mode === 'loading' || !ready ? <p role="status" aria-busy="true">{loading}</p> : <>
      <ReaderActionsProvider signedIn={Boolean(actingSubject)} signInHref={signInHref} actions={actions ?? undefined}>
        <ShelfButton work={work} title={work} locale={locale} size="lg" variant="outline" className="max-w-full" />
      </ReaderActionsProvider>
      {actingSubject ? <EpisodeProgress work={work} api={mainEpisodeApi(actingSubject, () => main)} t={copyOf(locale)} /> : <p>
        <Link href={librarySignInHref(locale)}>{libraryMessages.title}</Link>
      </p>}
    </>}
  </main>;
}
