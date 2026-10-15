'use client';

import { useEffect, useState, type ReactNode } from 'react';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { parsePlatformAccess, type PlatformAccess } from '../api/platform-access.ts';
import type { QueueView } from '../manage/routes.ts';
import { messages as shellMessages } from '../shell/messages.ts';
import shellJa from '../shell/messages/ja.ts';
import { ShellProvider } from '../shell/shell-provider.tsx';
import { recordedFetch, type RecordedSelection } from '../stories/recorded-fetch.ts';
import { recordedModerationRoute } from './realm-moderation-recorded-page.ts';

/**
 * The production moderation queue. Loading is a recorded request left
 * unanswered. The shell gate is the recorded platform-access grant; the story
 * does not choose which requests the queue or its sanction panel make.
 */
export function RecordedModerationPage({ record, persona, selections, realm, view, platformAccess, locale = 'en' }: {
  record: AnswerRecord;
  persona: AnswerPersona;
  selections: readonly RecordedSelection[];
  realm: string;
  view: QueueView;
  platformAccess: PlatformAccess;
  locale?: UiLocale;
}) {
  const [node, setNode] = useState<ReactNode>(null);
  const [failure, setFailure] = useState<Error | null>(null);
  const key = selections.map(item => `${item.label}:${item.state}`).join('|');
  useEffect(() => {
    let mounted = true;
    setNode(null); setFailure(null);
    let missed: string | null = null;
    const playback = recordedFetch(record, persona, selections, { pathPrefix: BFF_PREFIX, locale });
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
    const main = browserMainApi('https://recorded.invalid', { fetcher });
    void recordedModerationRoute(main, fetcher, realm, locale, view).then(result => {
      if (mounted && !missed) setNode(result);
    }).catch((error: unknown) => {
      if (!mounted || (error instanceof DOMException && error.name === 'AbortError')) return;
      setFailure(error instanceof Error ? error : new Error(String(error)));
    });
    return () => { mounted = false; playback.dispose(); };
  }, [record, persona, key, realm, view, locale, selections]);
  if (failure) throw failure;
  if (!node) return <p role="status" aria-busy="true">{locale === 'ja' ? shellJa.loading : shellMessages.loading}</p>;
  return <ShellProvider locale={locale} messages={locale === 'ja' ? { ...shellMessages, ...shellJa } : shellMessages} initialTheme="light" initialCollapsed={false}
    signedIn platformAccess={platformAccess}>{node}</ShellProvider>;
}

export function recordedPlatformAccess(record: AnswerRecord, persona: AnswerPersona): PlatformAccess {
  const sample = record.personas[persona].find(item => item.label === 'frame-platform-access');
  const access = sample ? parsePlatformAccess(sample.answer) : null;
  if (!access) throw new Error(`Recorded ${record.row}/${persona} has no platform-access grant`);
  return access;
}
