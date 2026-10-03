'use client';

import type { UiLocale } from '../../i18n/define.ts';
import { browserMainApi } from '../api/browser.ts';
import type { MainClient } from '../discover/types.ts';
import { type FollowActions, FollowControl } from '../profile/follow-button.tsx';
import { legacyFollowActions } from '../relationships/api.ts';
import type { FollowerCount } from '../profile/types.ts';
import type { ConceptMessages } from './messages.ts';

/**
 * Follows of a Concept through the BFF, as the session's Agent. Following a
 * Concept follows its one-Condition Filter (Main's `concept` follow kind).
 */
export function conceptFollowActions(target: string, actingSubject: string,
  main: () => MainClient = browserMainApi): Extract<FollowActions, { kind: 'ready' }> {
  return legacyFollowActions(target, actingSubject, main, 'concept');
}

/** Follow and the follower count, beside the Concept's name. */
export function ConceptFollow({ concept, name, following, revision, followers, signedIn, actingSubject, signInHref,
  actions, locale, messages }: {
  concept: string; name: string; following: boolean | null; revision: string | null; followers: FollowerCount | null;
  signedIn: boolean; actingSubject?: string | null; signInHref: string;
  /** Stories supply these; the page derives them from the session. */
  actions?: FollowActions;
  locale: UiLocale; messages: ConceptMessages;
}) {
  return <FollowControl target={concept} name={name} following={following} revision={revision} followers={followers}
    kind="concept" signedIn={signedIn} actingSubject={actingSubject} signInHref={signInHref} actions={actions} locale={locale}
    messages={messages} />;
}
