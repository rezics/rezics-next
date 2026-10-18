'use client';

import { useEffect, useState } from 'react';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { recordedFetch } from '../stories/recorded-fetch.ts';
import type { ReaderActions } from '../catalogue/reader-actions.tsx';
import { createReaderStore } from '../catalogue/reader-store.ts';
import { copyOf as levelsCopy } from '../work-levels/messages.ts';
import { EditionsPreviewView } from '../work-levels/previews.tsx';
import { booksEditionReads } from './books-edition-page.read.ts';
import { gamesAnswerLabel, readGamesHub, recordedGamesSelections } from './games-hub-recorded-page.ts';
import { messages } from './messages.ts';
import { NextActionView } from './primary-action.tsx';
import { Region } from './region.tsx';
import { WorkAbout } from './work-header.tsx';
import { WorkFrame } from './work-frame.tsx';
import { YourEdition } from './your-edition.tsx';

type Hub = Awaited<ReturnType<typeof readGamesHub>>;
type Shown = { hub: Hub; actions?: ReaderActions };

/** The Games hub slice: recorded availability, the reader's chooser and the primary action. */
export function GamesHubRecordedPage({ record, persona, mode, locale }: {
  record: AnswerRecord; persona: AnswerPersona; mode: 'populated' | 'saved' | 'loading'; locale: UiLocale;
}) {
  const [shown, setShown] = useState<Shown | null>(null);
  const [fault, setFault] = useState<string | null>(null);
  useEffect(() => {
    setShown(null);
    setFault(null);
    let headerLabel: string;
    let selections;
    try {
      headerLabel = gamesAnswerLabel(record, persona, ['work-header']);
      selections = recordedGamesSelections(record, persona, mode);
    } catch (error) { setFault(String(error)); return; }
    const header = record.personas[persona].find(item => item.label === headerLabel)!;
    const url = new URL(header.path, 'https://recorded.invalid');
    const actingSubject = url.searchParams.get('actingSubject') ?? undefined;
    const id = url.pathname.split('/').at(-1)!;
    const replay = recordedFetch(record, persona, selections, { pathPrefix: BFF_PREFIX });
    let mounted = true;
    const main = browserMainApi(window.location.origin, { anonymous: persona === 'visitor', fetcher: replay.fetcher });
    const client = { main, actingSubject };
    if (mode === 'loading') {
      void booksEditionReads(client).readWorkHeader(id);
      return () => { mounted = false; replay.dispose(); };
    }
    const actions = actingSubject ? createReaderStore({ actingSubject, main: () => main }) : undefined;
    void readGamesHub(client, id, locale).then(hub => { if (mounted) setShown({ hub, actions }); })
      .catch((error: unknown) => { if (mounted) setFault(String(error)); });
    return () => { mounted = false; replay.dispose(); };
  }, [record, persona, mode, locale]);
  const pageMessages = messages[locale];
  if (fault) return <pre role="alert" className="whitespace-pre-wrap break-words p-6">{fault}</pre>;
  if (!shown) return <p role="status" aria-busy="true" className="p-6">{pageMessages.loading}</p>;
  const { hub, actions } = shown;
  if (!hub.header.ok) return <pre role="alert" className="whitespace-pre-wrap break-words p-6">{hub.header.failure}</pre>;
  if (hub.book) return <pre role="alert" className="p-6">{pageMessages.unavailableBody}</pre>;
  const work = hub.header.data;
  const id = work.id.slice(-36);
  return <div lang={locale}>
    <WorkFrame workRef={id} work={work} credits={null} experience={hub.experience} locale={locale} messages={pageMessages}
      signedIn={persona !== 'visitor'} signInHref="/auth/start" readerActions={actions}
      readAction={hub.action ? <NextActionView action={hub.action} workRef={id} locale={locale} messages={pageMessages} /> : null}
      sections={hub.shown ? [{ id: 'availability', label: pageMessages.sectionAvailability }] : []}>
      <WorkAbout work={work} locale={locale} messages={pageMessages} />
      {hub.shown ? <Region id="availability" title={pageMessages.sectionAvailability}>
        <YourEdition work={work.id} signInHref="/auth/start" locale={locale} messages={pageMessages} />
        <EditionsPreviewView realizations={hub.realizations} releases={hub.releases} workRef={id} locale={locale}
          pageMessages={pageMessages} t={levelsCopy(locale)} />
      </Region> : null}
    </WorkFrame>
  </div>;
}

