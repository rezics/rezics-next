'use client';

import { useEffect, useState, type ReactNode } from 'react';
import type { AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import manga from '../../../../tests/qa/fixtures/outcomes/manga/catalogue-browse-and-search-in-its-zone.json';
import { mainApiWithToken } from '../api/main.ts';
import type { RealmReadClient } from '../realm/read.ts';
import { RealmBrowseRoute } from '../realm/routes.tsx';
import { messages as shellMessages } from '../shell/messages.ts';
import { PageContainer } from '../shell/page.tsx';
import { recordedFetch, type RecordedSelection, type RecordedState } from '../stories/recorded-fetch.ts';
import {
  mangaBrowsePersonas, recordedActingSubject, recordedFrameLabels, recordedSample, recordedSearch, recordedSiteKey,
} from './manga-browse-recorded-page.ts';

const record = manga as AnswerRecord;
const locale = 'en' as const;
type Persona = (typeof mangaBrowsePersonas)[number];

function selections(persona: Persona, label: string, state: RecordedState): RecordedSelection[] {
  return recordedFrameLabels(record, persona, label).map(item => ({
    label: item,
    state: item === label ? state : recordedSample(record, persona, item).status >= 400 ? 'error' : 'populated',
  }));
}

const pending = <PageContainer><p role="status" aria-busy="true">{shellMessages.loading}</p></PageContainer>;

/**
 * Manga browse through `RealmBrowseRoute` and the shared frame.
 * The page search is the recorded production request. The route builds the catalogue query.
 */
export function MangaBrowseRecordedPage({ persona, label, state }: {
  persona: Persona;
  label: string;
  state: RecordedState;
}) {
  const [node, setNode] = useState<ReactNode>(null);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    let active = true;
    const replay = recordedFetch(record, persona, selections(persona, label, state));
    const main = mainApiWithToken(undefined, { fetcher: replay.fetcher });
    // The same replaying fetch serves the frame reads and the membership control's hydration.
    const client: RealmReadClient & { fetch: typeof fetch } = {
      main,
      personal: persona === 'visitor' ? main : mainApiWithToken(`recorded-${persona}`, { fetcher: replay.fetcher }),
      actingSubject: recordedActingSubject(record, persona),
      signedIn: persona !== 'visitor',
      fetch: replay.fetcher,
    };
    void RealmBrowseRoute({
      params: Promise.resolve({ locale, realm: recordedSiteKey(record) }),
      searchParams: Promise.resolve(recordedSearch(record, persona, label)),
    }, undefined, client).then(rendered => {
      if (active) setNode(rendered);
    }).catch((reason: unknown) => {
      if (!active) return;
      setError(reason instanceof Error ? reason : new Error(String(reason)));
    });
    return () => {
      active = false;
      replay.dispose();
    };
  }, [persona, label, state]);
  if (error) throw error;
  if (!node) return pending;
  return node;
}
