'use client';

import { useEffect, useMemo, useState } from 'react';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { RealmUnavailable } from '../realm/states.tsx';
import { realmMessagesFor, RealmPageStory } from '../realm/story-page.tsx';
import type { Loaded } from '../realm/types.ts';
import { messages as shellMessages } from '../shell/messages.ts';
import { PageContainer } from '../shell/page.tsx';
import { recordedFetch, type RecordedState } from '../stories/recorded-fetch.ts';
import { ZoneBrowse } from './browse.tsx';
import type { BrowseModel } from './browse-view.ts';
import { zoneMessagesFor } from './fixtures.ts';
import { cardRenderer } from './zone-home.tsx';
import { loadRecordedBrowse, recordedBrowseSelections, recordedBrowseZone } from './visual-novels-browse-recorded-page.ts';

/** Recorded visual-novels browse, through the production browse readers. */
export function VisualNovelsBrowseRecordedPage({ record, persona, label, state, locale }: {
  record: AnswerRecord; persona: AnswerPersona; label: string; state: RecordedState; locale: UiLocale;
}) {
  const [page, setPage] = useState<Loaded<BrowseModel> | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const { zone, ref } = useMemo(() => recordedBrowseZone(record, persona, locale), [record, persona, locale]);
  const messages = useMemo(() => zoneMessagesFor(locale), [locale]);
  useEffect(() => {
    let active = true;
    const replay = recordedFetch(record, persona, recordedBrowseSelections(record, persona, label, state),
      { pathPrefix: BFF_PREFIX });
    const main = browserMainApi('https://recorded.invalid', { anonymous: true, fetcher: replay.fetcher });
    void loadRecordedBrowse(main, record, persona, label, zone, ref, locale, messages)
      .then(loaded => { if (active) setPage(loaded.result); })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason : new Error(String(reason))); });
    return () => { active = false; replay.dispose(); };
  }, [record, persona, label, state, locale, zone, ref, messages]);
  if (error) throw error;
  const loading = <PageContainer><p role="status" aria-busy="true">{shellMessages.loading}</p></PageContainer>;
  return <RealmPageStory zone={zone} locale={locale} site>
    {!page ? loading : page.ok
      ? <ZoneBrowse model={page.data} messages={messages} card={cardRenderer(zone, null, locale, messages)} />
      : <RealmUnavailable messages={realmMessagesFor(locale)} failure={page.failure} reference={page.reference} />}
  </RealmPageStory>;
}
