'use client';

import { useEffect, useMemo, useState } from 'react';
import { materializeData } from 'native-i18n';
import type { UiLocale } from '../../i18n/define.ts';
import type { MainClient } from '../discover/types.ts';
import { createReaderStore } from '../catalogue/reader-store.ts';
import { mainLibraryApi, saveYearlyGoal } from '../library/api.ts';
import { loadBooksLibrary } from '../library/books-library-recorded-page.ts';
import { mainImportApi } from '../library/import-api.ts';
import { LibraryPage } from '../library/library-page.tsx';
import { mainCopiesApi } from '../library/loans/api.ts';
import { messages } from '../library/messages.ts';
import { parseLibraryState } from '../library/state.ts';
import { mainExportApi } from '../library-backup/export-api.ts';
import type { MangaLibraryPersona } from './manga-collection-recorded-page.ts';

const state = parseLibraryState({ shelf: 'reading', view: 'grid' });

/** `/library`'s production reader and page, with the replaying client supplied at its session boundary. */
export function MangaCollectionRecordedPage({ main, persona, actingSubject, year, locale = 'en' }: {
  main: MainClient; persona: MangaLibraryPersona; actingSubject: string; year: number; locale?: UiLocale;
}) {
  const [loaded, setLoaded] = useState<{
    main: MainClient; actingSubject: string; locale: UiLocale; year: number;
    page: Awaited<ReturnType<typeof loadBooksLibrary>>;
  } | null>(null);
  useEffect(() => {
    let mounted = true;
    void loadBooksLibrary({ main, anonymous: main, actingSubject }, { state, locale, year, first: false }).then(page => {
      if (mounted) setLoaded({ main, actingSubject, locale, year, page });
    });
    return () => { mounted = false; };
  }, [main, actingSubject, year, locale]);
  const page = loaded?.main === main && loaded.actingSubject === actingSubject && loaded.locale === locale
    && loaded.year === year ? loaded.page : null;
  const actions = useMemo(() => page ? createReaderStore({ actingSubject, main: () => main,
    seed: page.view.ok ? page.view.data.seed : {} }) : null, [page, actingSubject, main]);
  return <div lang={locale} data-persona={persona} data-acting-subject={actingSubject}>
    <p lang="en" className="break-all px-4 pt-4 text-muted-foreground text-sm sm:px-6">{persona} · {actingSubject}</p>
    {!page || !actions ? <p role="status" className="p-6">{materializeData(messages, { locale }).loading}</p>
      : <LibraryPage state={state} {...page} now={Date.now()} locale={locale} messages={messages}
        api={mainLibraryApi(actingSubject, () => main)} readerActions={actions}
        saveGoal={(agent, savedYear, target, version) => saveYearlyGoal(agent, savedYear, target, version, () => main)}
        copiesApi={mainCopiesApi(actingSubject, () => main)} importApi={mainImportApi(actingSubject, () => main)}
        exportApi={mainExportApi(actingSubject, () => main)} />}
  </div>;
}
