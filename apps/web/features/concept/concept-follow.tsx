'use client';

import type { UiLocale } from '../../i18n/define.ts';
import { browserMainApi } from '../api/browser.ts';
import type { MainClient } from '../discover/types.ts';
import { type FollowActions, FollowControl } from '../profile/follow-button.tsx';
import type { FollowerCount } from '../profile/types.ts';
import type { ConceptMessages } from './messages.ts';

/**
 * Follows of a Concept through the BFF, as the session's Agent. Following a
 * Concept follows its one-Condition Filter (Main's `concept` follow kind).
 */
export function conceptFollowActions(target: string, actingSubject: string,
  main: () => MainClient = browserMainApi): Extract<FollowActions, { kind: 'ready' }> {
  return {
    kind: 'ready',
    async send(following, expectedRevision) {
      const { data, error } = await main().v1.follows.post({ profile: 'follow-command-v1', target, kind: 'concept',
        actingSubject, following, expectedRevision }, { headers: { 'idempotency-key': crypto.randomUUID() } });
      if (data) return { kind: 'saved', following: data.following, revision: data.revision };
      return error?.status === 409 ? { kind: 'stale' } : { kind: 'failed' };
    },
    async refresh() {
      const { data } = await main().v1.follows({ id: target.slice(-36) })
        .get({ query: { kind: 'concept', actingSubject } });
      return data ? { following: data.following ?? false, revision: data.revision } : null;
    },
  };
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
  const adapter: FollowActions = actions ?? (!signedIn ? { kind: 'signed-out', signInHref }
    : actingSubject ? conceptFollowActions(concept, actingSubject) : { kind: 'unavailable' });
  return <FollowControl target={concept} name={name} following={following} revision={revision} followers={followers}
    signedIn={signedIn} actingSubject={actingSubject} signInHref={signInHref} actions={adapter} locale={locale}
    messages={messages} />;
}
