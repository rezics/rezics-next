'use client';

import { materializeData } from 'native-i18n';
import { useEffect, useState } from 'react';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import type { MainClient } from '../discover/types.ts';
import { createReaderStore } from '../catalogue/reader-store.ts';
import { mainExportApi } from '../library-backup/export-api.ts';
import type { ExportStore } from '../library-backup/export-store.ts';
import { recordedFetch, type RecordedSelection } from '../stories/recorded-fetch.ts';
import { loadBooksLibrary } from './books-library-recorded-page.ts';
import { mainLibraryApi, saveYearlyGoal } from './api.ts';
import { mainCopiesApi } from './loans/api.ts';
import { mainImportApi } from './import-api.ts';
import type { ImportShelf } from './import-store.ts';
import { LibraryImport } from './library-import.tsx';
import { LibraryPage } from './library-page.tsx';
import { messages as libraryMessages, type LibraryMessages } from './messages.ts';
import { parseLibraryState, type LibraryState } from './state.ts';

const firstPage = parseLibraryState({});

function useRecordedClient(record: AnswerRecord, persona: AnswerPersona, selections: readonly RecordedSelection[]) {
  const [client, setClient] = useState<MainClient | null>(null);
  useEffect(() => {
    const replay = recordedFetch(record, persona, selections, { pathPrefix: BFF_PREFIX });
    const next = browserMainApi(window.location.origin, { fetcher: replay.fetcher });
    // The Eden client is a function. Passing it to the setter would run it as an updater.
    setClient(() => next);
    return () => { replay.dispose(); setClient(null); };
  }, [record, persona, selections]);
  return client;
}

/** The library route's mapping, fed by one recorded persona. */
export function BooksLibraryRecorded({ record, persona, selections, actingSubject, year, locale = 'en',
  messages = libraryMessages, state = firstPage, importShelf, exportStore }: {
  record: AnswerRecord; persona: AnswerPersona; selections: readonly RecordedSelection[];
  actingSubject: string; year: number; locale?: UiLocale; messages?: LibraryMessages;
  state?: LibraryState; importShelf?: ImportShelf; exportStore?: ExportStore;
}) {
  const client = useRecordedClient(record, persona, selections);
  const [loaded, setLoaded] = useState<{
    client: MainClient; actingSubject: string; state: LibraryState; locale: UiLocale; year: number;
    record: AnswerRecord; persona: AnswerPersona; selections: readonly RecordedSelection[];
    page: Awaited<ReturnType<typeof loadBooksLibrary>>;
  } | null>(null);
  const t = materializeData(messages, { locale });
  useEffect(() => {
    if (!client) return;
    let current = true;
    const reader = { main: client, anonymous: client, actingSubject };
    void loadBooksLibrary(reader, { state, locale, year, first: state.shelf.kind === 'all' && state.cursor === null })
      .then(page => { if (current) setLoaded({ client, actingSubject, state, locale, year,
        record, persona, selections, page }); });
    return () => { current = false; };
  }, [actingSubject, client, locale, state, year, record, persona, selections]);
  if (!client || !loaded || loaded.client !== client || loaded.actingSubject !== actingSubject
    || loaded.state !== state || loaded.locale !== locale || loaded.year !== year || loaded.record !== record
    || loaded.persona !== persona || loaded.selections !== selections) return <p role="status">{t.loading}</p>;
  const page = loaded.page;
  // Reader stores retain their client for a visit; a different replay must start a fresh visit.
  const visit = [actingSubject, persona, record.row, year, locale,
    ...selections.map(selection => `${selection.label}:${selection.state}`)].join('|');
  return <LibraryPage key={visit} state={state} {...page} now={0} locale={locale} messages={messages}
    api={mainLibraryApi(actingSubject, () => client)}
    saveGoal={(agent, year, target, version) => saveYearlyGoal(agent, year, target, version, () => client)}
    copiesApi={mainCopiesApi(actingSubject, () => client)}
    readerActions={createReaderStore({ actingSubject, main: () => client,
      seed: page.view.ok ? page.view.data.seed : {} })}
    importApi={mainImportApi(actingSubject, () => client)} importShelf={importShelf}
    exportApi={mainExportApi(actingSubject, () => client)} exportStore={exportStore} />;
}

/** A saved import the page opens through the production import adapter. */
export function RecordedLibraryImport({ record, persona, selections, actingSubject, shelf, locale = 'en',
  messages = libraryMessages }: {
  record: AnswerRecord; persona: AnswerPersona; selections: readonly RecordedSelection[];
  actingSubject: string; shelf: ImportShelf; locale?: UiLocale; messages?: LibraryMessages;
}) {
  const client = useRecordedClient(record, persona, selections);
  const t = materializeData(messages, { locale });
  if (!client) return <p role="status">{t.loading}</p>;
  return <LibraryImport agent={actingSubject} context={null} locale={locale} messages={messages} shelf={shelf}
    api={mainImportApi(actingSubject, () => client)} />;
}
