'use client';

import { cn } from '@rezics/ui/utils';
import { useMemo, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { browserMainApi } from '../api/browser.ts';
import type { MainClient } from '../discover/types.ts';
import { RelationshipControl } from '../relationships/control.tsx';
import { legacyFollowActions, mainRelationships } from '../relationships/api.ts';
import { storyFollowApi } from '../relationships/legacy.ts';
import { type FollowMessages, followerLabel } from './followers.ts';
import type { FollowerCount } from './types.ts';

/** What a follow write came to: saved with Main's new revision, stale (changed elsewhere first) or failed. */
export type FollowOutcome = { kind: 'saved'; following: boolean; revision: string } | { kind: 'stale' } | { kind: 'failed' };

/**
 * The seam between the follow control and Main (G-282's follows API), as
 * `ReaderActions` is for shelves. Signed out, the control leads to sign-in;
 * signed in without an Agent to act as, none is drawn rather than one that
 * cannot act; stories supply an in-memory `ready` adapter.
 */
export type FollowActions =
  | { kind: 'unavailable' }
  | { kind: 'signed-out'; signInHref: string }
  | {
    kind: 'ready';
    send: (following: boolean, expectedRevision: string | null) => Promise<FollowOutcome>;
    /** The reader's current follow, read again after a stale write. */
    refresh: () => Promise<{ following: boolean; revision: string | null } | null>;
  };

/** Who a follow names: a REZICS Agent by IRI, or an Open Library author as `open-library:OL…A`. */
export type AuthorFollowKind = 'agent' | 'external-author';

/** Follows of an author through the BFF, as the session's Agent. Each press is its own idempotent command. */
export function mainFollowActions(target: string, actingSubject: string,
  main: () => MainClient = browserMainApi, kind: AuthorFollowKind = 'agent'): Extract<FollowActions, { kind: 'ready' }> {
  return legacyFollowActions(target, actingSubject, main, kind);
}

/** Follow and follower count use the same relationship control as every other resource. */
export function FollowControl({ target, kind = 'agent', name, following, revision, followers, signedIn, actingSubject,
  signInHref, actions, locale, messages, className }: {
  target: string; kind?: string; name: string; following: boolean | null; revision: string | null;
  followers: FollowerCount | null; signedIn: boolean; actingSubject?: string | null; signInHref: string;
  actions?: FollowActions; locale: UiLocale; messages: FollowMessages; className?: string;
}) {
  const [count, setCount] = useState(followers);
  const [before, setBefore] = useState(following);
  const initial = { following, revision, level: null, source: null, pinPosition: null };
  const api = useMemo(() => {
    const base = mainRelationships(actingSubject ?? '');
    return actions?.kind === 'ready' ? storyFollowApi(base, actions,
      { ...initial, level: kind === 'concept' ? 'off' : kind === 'work' ? 'all' : 'highlights' }) : undefined;
  }, [actions, actingSubject, target]);
  return <div className={cn('flex flex-wrap items-center gap-x-4 gap-y-2', className)}>
    <RelationshipControl target={target} kind={kind} name={name} locale={locale} signedIn={signedIn}
      actingSubject={actions?.kind === 'unavailable' ? null : actingSubject}
      signInHref={actions?.kind === 'signed-out' ? actions.signInHref : signInHref} initial={initial} api={api}
      onChange={state => {
        if (count?.kind === 'exact' && before !== null && before !== state.following)
          setCount({ ...count, value: Math.max(0, count.value + (state.following ? 1 : -1)) });
        setBefore(state.following);
      }} />
    {count ? <span className="text-muted-foreground text-sm tabular-nums">{followerLabel(count, locale, messages)}</span> : null}
  </div>;
}
