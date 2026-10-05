'use client';

import { useMemo } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { mainScopedRatingApi, type QuestionScope, type ScopedRatingApi } from './api.ts';
import type { ScopedRatingMessages } from './messages.ts';
import { QuestionList, type Viewer } from './question-rating.tsx';

/**
 * The questions asked of one place (a subject in an episode, a match, a continuity) on that place's own page: each with
 * its figures, the person's own rating and the way to review and discuss it, which are the sections of the same page.
 */
export function PlaceJudgments({ target, scope = { kind: 'global' }, actingSubject, signInHref, api: provided, locale, messages, className }: {
  target: string; scope?: QuestionScope; actingSubject: string | null; signInHref: string;
  /** Main through the browser, unless a story or test supplies its own. */
  api?: ScopedRatingApi; locale: UiLocale; messages: ScopedRatingMessages; className?: string;
}) {
  const api = useMemo(() => provided ?? mainScopedRatingApi({ actingSubject }), [provided, actingSubject]);
  const viewer: Viewer = actingSubject ? { kind: 'reader' } : { kind: 'signed-out', signInHref };
  return <QuestionList api={api} target={target} scope={scope} viewer={viewer} heading={false} locale={locale}
    messages={messages} className={className} />;
}
