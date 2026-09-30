'use client';

import { useRouter } from 'next/navigation';
import { materializeData } from 'native-i18n';
import { createContext, type ReactNode, use, useMemo, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { type ReaderActions, ReaderActionsProvider, type ReadingStatus } from '../catalogue/reader-actions.tsx';
import { createReaderStore, type ReaderSeed } from '../catalogue/reader-store.ts';
import { type LibraryApi, mainLibraryApi } from './api.ts';
import { statusLabel } from './labels.ts';
import type { LibraryMessages } from './messages.ts';

type ReadyActions = Extract<ReaderActions, { kind: 'ready' }>;

export interface LibraryNotice { tone: 'default' | 'destructive'; text: string }

interface LibraryContextValue {
  /** The Agent the reader acts as. */
  actingSubject: string;
  api: LibraryApi;
  /** The catalogue's reader actions, so row and bulk moves share one status store with every shelf button. */
  reader: ReadyActions;
  /** The standing Global rating question; null draws no stars or reviews. */
  ratingContext: string | null;
  /** Reads the page again from Main after a write, so counts and shelves agree with it. */
  refresh: () => void;
  /** Moves Works to a status shelf, or off every one, one after another; answers how many Main refused. */
  moveWorks: (works: readonly string[], status: ReadingStatus | null) => Promise<number>;
  notice: LibraryNotice | null;
  announce: (notice: LibraryNotice | null) => void;
}

const LibraryContext = createContext<LibraryContextValue | null>(null);

export function useLibrary(): LibraryContextValue {
  const value = use(LibraryContext);
  if (!value) throw new Error('useLibrary needs a LibraryProvider');
  return value;
}

/**
 * Library's writes for the session's Agent. Status changes go through the
 * catalogue's reader store; ratings through Library's API, since a library
 * rates many Works and reads each one's Main Version when it is rated. Stories
 * pass `api` and `readerActions` to run against memory.
 */
export function LibraryProvider({ actingSubject, seed, ratingContext, titles, api, readerActions, locale, messages,
  children }: {
  actingSubject: string; seed: ReaderSeed; ratingContext: string | null;
  /** The shown Works' titles, so a move made from a row can say which Work went where. */
  titles: Record<string, string>;
  api?: LibraryApi; readerActions?: ReadyActions; locale: UiLocale; messages: LibraryMessages; children: ReactNode;
}) {
  const router = useRouter();
  const [library] = useState(() => api ?? mainLibraryApi(actingSubject));
  const [store] = useState(() => readerActions ?? createReaderStore({ actingSubject, seed }));
  const [notice, announce] = useState<LibraryNotice | null>(null);
  const value = useMemo<LibraryContextValue>(() => {
    const refresh = () => router.refresh();
    const reader: ReadyActions = { ...store,
      async setStatus(work, status) {
        const saved = await store.setStatus(work, status);
        if (!saved) return false;
        // The row may leave this shelf when the page reads again; say where the Work went.
        const t = materializeData(messages, { locale });
        const title = titles[work];
        if (title) announce({ tone: 'default', text: status ? t.movedOne({ title, shelf: statusLabel(status, t) })
          : t.removedOne({ title }) });
        refresh();
        return true;
      },
      rate: ratingContext ? async (work, value) => {
        if (value === null) return false;
        const saved = await library.rate(work, value, ratingContext);
        if (saved.ok) refresh();
        return saved.ok;
      } : null };
    async function moveWorks(works: readonly string[], status: ReadingStatus | null) {
      let refused = 0;
      // One at a time: each is its own compare-and-set, and Main meters writes per reader.
      for (const work of works) if (!await store.setStatus(work, status).catch(() => false)) refused += 1;
      refresh();
      return refused;
    }
    return { actingSubject, api: library, reader, ratingContext, refresh, moveWorks, notice, announce };
  }, [actingSubject, library, store, ratingContext, router, notice, titles, locale, messages]);
  return <LibraryContext value={value}>
    <ReaderActionsProvider signedIn signInHref="/" actions={value.reader}>{children}</ReaderActionsProvider>
  </LibraryContext>;
}
