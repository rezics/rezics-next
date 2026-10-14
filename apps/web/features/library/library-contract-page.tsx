'use client';

import { useEffect, useState } from 'react';
import { materializeData } from 'native-i18n';
import type { UiLocale } from '../../i18n/define.ts';
import { createReaderStore } from '../catalogue/reader-store.ts';
import { memoryExportStore } from '../library-backup/export-store.ts';
import { mainLibraryApi, saveYearlyGoal } from './api.ts';
import { loadBooksLibrary } from './books-library-recorded-page.ts';
import { libraryContractFixture, type LibraryContractState, type LibraryMedium } from './library-contract-fixtures.ts';
import { LibraryPage } from './library-page.tsx';
import { messages } from './messages.ts';
import { mainImportApi } from './import-api.ts';
import { memoryImportShelf } from './import-store.ts';
import { mainExportApi } from '../library-backup/export-api.ts';
import { mainCopiesApi } from './loans/api.ts';
import type { AnswerPersona } from '../../../../scripts/api/answer-record.ts';

/** Constructed, unrecorded states cross the same typed client, reader and page as a Library visit. */
export function LibraryContractPage({ medium, state = 'populated', persona = 'member', locale = 'en' }: {
  medium: LibraryMedium; state?: LibraryContractState; persona?: AnswerPersona; locale?: UiLocale;
}) {
  const [fixture] = useState(() => libraryContractFixture(medium, state, persona));
  const [store] = useState(memoryExportStore);
  const [imports] = useState(() => memoryImportShelf(state === 'pending' ? [{ id: fixture.importId,
    name: 'Original library import', format: 'rezics', total: 1, createdAt: Date.now(), intent: null }] : []));
  const [loaded, setLoaded] = useState<Awaited<ReturnType<typeof loadBooksLibrary>> | null>(null);
  useEffect(() => {
    let current = true;
    void loadBooksLibrary(fixture.reader, { state: fixture.state, locale, year: 2026,
      first: fixture.state.shelf.kind === 'all' }).then(result => { if (current) setLoaded(result); });
    return () => { current = false; };
  }, [fixture, locale]);
  if (!loaded) return <p role="status">{materializeData(messages, { locale }).loading}</p>;
  return <LibraryPage state={fixture.state} {...loaded} now={0} locale={locale} messages={messages}
    exportStore={store} api={mainLibraryApi(fixture.actor, () => fixture.main)}
    saveGoal={(agent, year, target, version) => saveYearlyGoal(agent, year, target, version, () => fixture.main)}
    importApi={mainImportApi(fixture.actor, () => fixture.main)} importShelf={imports}
    exportApi={mainExportApi(fixture.actor, () => fixture.main)} copiesApi={mainCopiesApi(fixture.actor, () => fixture.main)}
    readerActions={createReaderStore({ actingSubject: fixture.actor, main: () => fixture.main,
      seed: loaded.view.ok ? loaded.view.data.seed : {} })} />;
}
