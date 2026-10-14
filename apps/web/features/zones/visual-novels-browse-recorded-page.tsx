import { useEffect, useState, type ReactNode } from 'react';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { RealmBrowseRoute } from '../realm/routes.tsx';
import { messages as shellMessages } from '../shell/messages.ts';
import { PageContainer } from '../shell/page.tsx';
import { recordedFetch, type RecordedState } from '../stories/recorded-fetch.ts';
import {
  BFF_PREFIX, recordedActingSubject, recordedBrowseClient, recordedBrowseSearch, recordedBrowseSelections,
  recordedSiteKey,
} from './visual-novels-browse-recorded-page.ts';

/**
 * Recorded visual-novels browse through `RealmBrowseRoute`.
 * Loading holds the page's browse request unanswered, so the route has not returned the frame yet.
 */
export function VisualNovelsBrowseRecordedPage({ record, persona, label, state, locale }: {
  record: AnswerRecord; persona: AnswerPersona; label: string; state: RecordedState; locale: UiLocale;
}) {
  const [node, setNode] = useState<ReactNode>(null);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    let active = true;
    const replay = recordedFetch(record, persona, recordedBrowseSelections(record, persona, label, state),
      { pathPrefix: BFF_PREFIX });
    const client = recordedBrowseClient(replay.fetcher, persona, recordedActingSubject(record, persona));
    void RealmBrowseRoute({
      params: Promise.resolve({ locale, realm: recordedSiteKey(record) }),
      searchParams: Promise.resolve(recordedBrowseSearch(record, persona, label)),
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
  }, [record, persona, label, state, locale]);
  if (error) throw error;
  if (!node) return <PageContainer><p role="status" aria-busy="true">{shellMessages.loading}</p></PageContainer>;
  return node;
}
