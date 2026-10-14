'use client';

import { useEffect, useState, type ReactNode } from 'react';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import { BFF_PREFIX } from '../api/browser.ts';
import { messages as shellMessages } from '../shell/messages.ts';
import { recordedFetch, type RecordedSelection } from '../stories/recorded-fetch.ts';
import {
  recordedIdentity, recordedRead, recordedReplay, recordedRequestsRoute, recordedRealmRoute,
  type MembershipSurface,
} from './realm-membership-recorded-page.ts';

/**
 * One recorded membership route. The story holds no reader of its own: loading
 * is a recorded request left unanswered, and every other state comes from the
 * production route.
 */
export function RecordedMembershipPage({ record, persona, selections, surface, locale = 'en' }: {
  record: AnswerRecord;
  persona: AnswerPersona;
  selections: readonly RecordedSelection[];
  surface: MembershipSurface;
  locale?: 'en';
}) {
  const [view, setView] = useState<ReactNode>(null);
  useEffect(() => {
    let mounted = true;
    let missed: string | null = null;
    const playback = recordedFetch(record, persona, selections, { pathPrefix: BFF_PREFIX });
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      try { return await playback.fetcher(input, init); }
      catch (error) {
        missed = error instanceof Error ? error.message : String(error);
        throw error;
      }
    }) as typeof fetch;
    const identity = recordedIdentity(record, persona, selections);
    const route = surface === 'requests'
      ? recordedRequestsRoute(recordedReplay(fetcher, true).personal, fetcher, identity.realm, locale)
      : recordedRealmRoute(recordedReplay(fetcher, surface !== 'landing'), identity.realm, locale);
    void route.then(result => {
      if (mounted && !missed) setView(result);
    }).catch((error: unknown) => {
      if (!mounted || (error instanceof DOMException && error.name === 'AbortError')) return;
      throw error;
    });
    return () => { mounted = false; playback.dispose(); };
  }, [record, persona, selections, surface, locale]);
  if (!view) return <p role="status" aria-busy="true">{shellMessages.loading}</p>;
  return view;
}

export { recordedRead };
