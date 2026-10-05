'use client';

import { useMemo } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { mainScopedRatingApi, type ProjectionRead, type QuestionScope, type ScopedRatingApi } from './api.ts';
import { FailureNote } from './failure.tsx';
import { translate } from './format.ts';
import type { ScopedRatingMessages } from './messages.ts';
import { ParticipantRanking } from './participant-ranking.tsx';
import { useLoad } from './use-load.ts';

/**
 * An event's participants ranked for the first question that accepts them. The question is the host's to choose when it knows
 * one; otherwise the first Main lists for the participants, so a ranking never mixes two questions.
 */
export function EventRanking({ participants, retry, scope = { kind: 'global' }, actingSubject, api: provided, locale, messages, className }: {
  participants: readonly ProjectionRead[]; retry?: () => void; scope?: QuestionScope; actingSubject: string | null;
  /** Main through the browser, unless a story or test supplies its own. */
  api?: ScopedRatingApi; locale: UiLocale; messages: ScopedRatingMessages; className?: string;
}) {
  const t = translate(messages, locale);
  const api = useMemo(() => provided ?? mainScopedRatingApi({ actingSubject }), [provided, actingSubject]);
  const first = participants.find(read => read.summary?.status === 'available')?.projection.id ?? null;
  const [asked, reload] = useLoad(async () => first ? api.questions(first, scope) : { ok: true as const, data: [] },
    `${first}\n${scope.kind === 'realm' ? scope.realm : 'global'}`);
  if (asked.state === 'loading') return <p className="text-muted-foreground text-sm" aria-busy="true">{t.loading}</p>;
  if (asked.state === 'failed') return <FailureNote failure={asked.failure} locale={locale} messages={messages} retry={reload} />;
  const question = asked.data[0];
  if (!question) {
    // Participants whose summaries could not be read are why no question was found; saying nothing would pass as no ranking.
    return participants.some(read => read.summary === null)
      ? <FailureNote failure="unavailable" locale={locale} messages={messages} retry={retry} className={className} /> : null;
  }
  return <ParticipantRanking question={question} participants={participants} api={api} retry={retry} level={2} locale={locale}
    messages={messages} className={className} />;
}
