'use client';

import { useEffect, useState, type ReactNode } from 'react';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import anime from '../../../../tests/qa/fixtures/outcomes/anime/catalogue-browse-and-search-in-its-zone.json';
import type { UiLocale } from '../../i18n/define.ts';
import { mainApiWithToken } from '../api/main.ts';
import { RealmBrowseRoute } from '../realm/routes.tsx';
import type { RealmReadClient } from '../realm/read.ts';
import { messages as shellMessages } from '../shell/messages.ts';
import { PageContainer } from '../shell/page.tsx';
import { recordedFetch, type RecordedState } from '../stories/recorded-fetch.ts';
import { animeBrowseActor, animeBrowseLabels, animeBrowseSample, animeBrowseSearch, animeBrowseSiteKey } from './anime-browse-recorded-page.ts';

const record = anime as AnswerRecord;

/** The production browse route resolves its own frame, catalogue and relationship controls. */
export function AnimeBrowseRecordedPage({ persona, label, state, locale = 'en' }: {
  persona: AnswerPersona; label: string; state: RecordedState; locale?: UiLocale;
}) {
  const [node, setNode] = useState<ReactNode>(null);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    let active = true;
    setNode(null);
    setError(null);
    const replay = recordedFetch(record, persona, animeBrowseLabels(record, persona, label).map(item => ({
      label: item, state: item === label ? state : animeBrowseSample(record, persona, item).status >= 400 ? 'error' : 'populated',
    })));
    const fail = (reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason : new Error(String(reason)));
    };
    // A swallowed read failure must still fail a story when its cause is a missing recorded request.
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      try { return await replay.fetcher(input, init); }
      catch (reason) { if (!(reason instanceof DOMException && reason.name === 'AbortError')) fail(reason); throw reason; }
    }) as typeof fetch;
    const main = mainApiWithToken(undefined, { fetcher });
    const client: RealmReadClient & { fetch: typeof fetch } = {
      main, personal: persona === 'visitor' ? main : mainApiWithToken(`recorded-${persona}`, { fetcher }),
      signedIn: persona !== 'visitor', actingSubject: animeBrowseActor(record, persona), fetch: fetcher,
    };
    void RealmBrowseRoute({
      params: Promise.resolve({ locale, realm: animeBrowseSiteKey(record) }),
      searchParams: Promise.resolve(animeBrowseSearch(record, persona, label)),
    }, undefined, client).then(rendered => { if (active) setNode(rendered); }).catch(fail);
    return () => { active = false; replay.dispose(); };
  }, [persona, label, state, locale]);
  if (error) throw error;
  return node ?? <PageContainer><p role="status" aria-busy="true">{shellMessages.loading}</p></PageContainer>;
}
