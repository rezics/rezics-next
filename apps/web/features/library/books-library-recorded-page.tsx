'use client';

import { materializeData } from 'native-i18n';
import { useEffect, useState } from 'react';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import type { MainClient } from '../discover/types.ts';
import { mainExportApi } from '../library-backup/export-api.ts';
import type { ExportStore } from '../library-backup/export-store.ts';
import { recordedFetch, type RecordedSelection } from '../stories/recorded-fetch.ts';
import { workHref } from '../work-page/route.ts';
import { loadBooksLibrary, loadSecondDeviceProgress } from './books-library-recorded-page.ts';
import { mainImportApi } from './import-api.ts';
import type { ImportShelf } from './import-store.ts';
import { LibraryImport } from './library-import.tsx';
import { LibraryPage } from './library-page.tsx';
import { messages as libraryMessages, type LibraryMessages } from './messages.ts';
import { ReadingProgress } from './row-parts.tsx';
import { parseLibraryState, type LibraryState } from './state.ts';
import type { LibraryRow } from './types.ts';

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
  const [loaded, setLoaded] = useState<Awaited<ReturnType<typeof loadBooksLibrary>> | null>(null);
  const t = materializeData(messages, { locale });
  useEffect(() => {
    if (!client) return;
    let current = true;
    const reader = { main: client, anonymous: client, actingSubject };
    void loadBooksLibrary(reader, { state, locale, year, first: state.shelf.kind === 'all' && state.cursor === null })
      .then(page => { if (current) setLoaded(page); });
    return () => { current = false; };
  }, [actingSubject, client, locale, state, year]);
  if (!client || !loaded) return <p role="status">{t.loading}</p>;
  return <LibraryPage state={state} {...loaded} now={0} locale={locale} messages={messages}
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

/**
 * The second device's winning place. The resume label and the saved position
 * both come from the production tracking adapter's recorded answers.
 */
export function RecordedSecondDeviceProgress({ record, persona, selections, actingSubject, work, episode,
  locale = 'en', messages = libraryMessages }: {
  record: AnswerRecord; persona: AnswerPersona; selections: readonly RecordedSelection[];
  actingSubject: string; work: string; episode: { structure: string; occurrence: string };
  locale?: UiLocale; messages?: LibraryMessages;
}) {
  const client = useRecordedClient(record, persona, selections);
  const [row, setRow] = useState<LibraryRow | null>(null);
  const [position, setPosition] = useState<string | null>(null);
  const t = materializeData(messages, { locale });
  useEffect(() => {
    if (!client) return;
    let current = true;
    void loadSecondDeviceProgress(client, { actingSubject, work, episode }).then(read => {
      if (!current) return;
      const label = read.resume.ok ? read.resume.data?.label ?? null : null;
      const saved = read.progress.ok ? read.progress.data.position : null;
      setPosition(saved);
      setRow({ work: { id: work, href: workHref(work.slice(-36)), title: null, cover: null, kind: 'book', authors: [],
        rating: null }, types: [], status: 'reading', version: read.progress.ok ? read.progress.data.version : 0,
      shelvedAt: null, startedOn: null, finishedOn: null, rating: null, lastReadAt: null, customShelves: [],
      progress: { next: label ? { title: label, href: workHref(work.slice(-36)) } : null, left: null, chapters: null } });
    });
    return () => { current = false; };
  }, [actingSubject, client, episode, work]);
  if (!row) return <p role="status">{t.loading}</p>;
  return <section aria-labelledby="library-reading" className="grid gap-3 p-4">
    <h2 id="library-reading" className="font-semibold text-xl">{t.currentlyReading}</h2>
    {position ? <p>{position}</p> : null}
    <ReadingProgress row={row} locale={locale} messages={messages} />
  </section>;
}
