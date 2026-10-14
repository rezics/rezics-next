'use client';

import { useEffect, useState, type ReactNode } from 'react';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { membershipRecordedTransition, type MembershipReplayPhase } from './membership-recorded-transition.ts';
import { BFF_PREFIX } from '../api/browser.ts';
import { messages as shellMessages } from '../shell/messages.ts';
import { recordedFetch, type RecordedSelection } from '../stories/recorded-fetch.ts';
import {
  recordedIdentity, recordedMembersRoute, recordedRead, recordedReplay, recordedRequestsRoute, recordedRealmRoute, recordedSample, recordedManagementAgent,
  type MembershipSurface,
} from './realm-membership-recorded-page.ts';

/**
 * One recorded membership route. The story holds no reader of its own: loading
 * is a recorded request left unanswered, and every other state comes from the
 * production route.
 */
export function RecordedMembershipPage({ record, persona, selections, surface, sequence = false, phases, locale = 'en' }: {
  record: AnswerRecord;
  persona: AnswerPersona;
  selections: readonly RecordedSelection[];
  surface: MembershipSurface;
  sequence?: boolean;
  locale?: UiLocale;
  phases?: readonly MembershipReplayPhase[];
}) {
  const [view, setView] = useState<ReactNode>(null);
  const [failure, setFailure] = useState<Error | null>(null);
  useEffect(() => {
    let mounted = true;
    setView(null); setFailure(null);
    let missed: string | null = null;
    const playback = phases ? membershipRecordedTransition(record, persona, phases)
      : recordedFetch(record, persona, selections, { pathPrefix: BFF_PREFIX, sequence });
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      try { return await playback.fetcher(input, init); }
      catch (error) {
        if (mounted && !(error instanceof DOMException && error.name === 'AbortError')) {
          missed = error instanceof Error ? error.message : String(error);
          setFailure(new Error(missed));
        }
        throw error;
      }
    }) as typeof fetch;
    const identity = recordedIdentity(record, persona, selections);
    const replay = recordedReplay(fetcher, surface !== 'landing');
    const invitation = surface === 'members'
      ? recordedSample(record, persona, 'invitation-confirm').answer as { invitation: { createdAt: string } } : null;
    // Time-bound invitation controls are inspected at their recorded receipt time.
    const now = invitation ? Date.parse(invitation.invitation.createdAt) : undefined;
    const session = phases && (surface === 'members' || surface === 'requests')
      ? recordedManagementAgent(fetcher, locale) : undefined;
    const renderRoute = async (): Promise<void> => {
      const route = surface === 'members'
        ? recordedMembersRoute(replay.personal, fetcher, identity.realm, locale,
          phases ? renderRoute : () => { void renderRoute(); }, now, await session)
        : surface === 'requests'
          ? recordedRequestsRoute(replay.personal, fetcher, identity.realm, locale, await session)
          : recordedRealmRoute(replay, identity.realm, locale);
      return route.then(result => {
        if (mounted && !missed) setView(result);
      }).catch((error: unknown) => {
        if (!mounted || (error instanceof DOMException && error.name === 'AbortError')) return;
        setFailure(error instanceof Error ? error : new Error(String(error)));
      });
    };
    void renderRoute();
    return () => { mounted = false; playback.dispose(); };
  }, [record, persona, selections, surface, sequence, phases, locale]);
  if (failure) throw failure;
  if (!view) return <p role="status" aria-busy="true">{shellMessages.loading}</p>;
  return view;
}

export { recordedRead };
