'use client';

import { Button, buttonVariants } from '@rezics/ui/button';
import { cn } from '@rezics/ui/utils';
import { CheckIcon, PlusIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import { useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { browserMainApi } from '../api/browser.ts';
import type { MainClient } from '../discover/types.ts';
import Link from '../shell/localized-link.tsx';
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
  return {
    kind: 'ready',
    async send(following, expectedRevision) {
      const { data, error } = await main().v1.follows.post({ profile: 'follow-command-v1', target, kind,
        actingSubject, following, expectedRevision }, { headers: { 'idempotency-key': crypto.randomUUID() } });
      if (data) return { kind: 'saved', following: data.following, revision: data.revision };
      return error?.status === 409 ? { kind: 'stale' } : { kind: 'failed' };
    },
    async refresh() {
      const { data } = kind === 'agent'
        ? await main().v1.follows({ id: target.slice(-36) }).get({ query: { kind: 'agent', actingSubject } })
        : await main().v1.authors['open-library']({ author: target.slice('open-library:'.length) }).follow
          .get({ query: { actingSubject } });
      return data ? { following: data.following ?? false, revision: data.revision } : null;
    },
  };
}

const bump = (followers: FollowerCount | null, by: number): FollowerCount | null =>
  followers?.kind === 'exact' ? { kind: 'exact', value: Math.max(0, followers.value + by) } : followers;

/**
 * Follow and the follower count beside it, as Goodreads sets them under an
 * author's photo. The press shows at once and is taken back with a note when
 * Main refuses; when the follow changed in another tab first, it reads the
 * follow again and applies the reader's choice once more.
 */
export function FollowControl({ target, kind = 'agent', name, following, revision, followers, signedIn, actingSubject,
  signInHref, actions, locale, messages, className }: {
  /** The Agent IRI, or an Open Library author's `open-library:OL…A`. */
  target: string; kind?: AuthorFollowKind; name: string;
  /** The reader's follow as the page read it; null when it could not be read or they are signed out. */
  following: boolean | null; revision: string | null;
  /** Null when Main could not count them; the count is then left out. */
  followers: FollowerCount | null;
  signedIn: boolean; actingSubject?: string | null; signInHref: string;
  /** Stories supply these; pages derive them from the session. */
  actions?: FollowActions;
  locale: UiLocale; messages: FollowMessages; className?: string;
}) {
  const t = materializeData(messages, { locale });
  const [adapter] = useState<FollowActions>(() => actions ?? (!signedIn ? { kind: 'signed-out', signInHref }
    : actingSubject ? mainFollowActions(target, actingSubject, browserMainApi, kind) : { kind: 'unavailable' }));
  const [state, setState] = useState({ following: following ?? false, revision, followers });
  const [status, setStatus] = useState<'idle' | 'saving' | 'failed'>('idle');

  async function toggle() {
    if (adapter.kind !== 'ready' || status === 'saving') return;
    const before = state;
    const next = !before.following;
    setState({ ...before, following: next, followers: bump(before.followers, next ? 1 : -1) });
    setStatus('saving');
    let outcome = await adapter.send(next, before.revision).catch((): FollowOutcome => ({ kind: 'failed' }));
    if (outcome.kind === 'stale') {
      const fresh = await adapter.refresh().catch(() => null);
      outcome = !fresh ? { kind: 'failed' }
        : fresh.following === next && fresh.revision ? { kind: 'saved', following: next, revision: fresh.revision }
          : await adapter.send(next, fresh.revision).catch((): FollowOutcome => ({ kind: 'failed' }));
    }
    if (outcome.kind === 'saved') {
      const saved = outcome;
      setState(current => ({ ...current, following: saved.following, revision: saved.revision }));
      setStatus('idle');
    } else {
      setState(before);
      setStatus('failed');
    }
  }

  const count = state.followers ? <span className="text-muted-foreground text-sm tabular-nums">
    {followerLabel(state.followers, locale, messages)}</span> : null;
  if (adapter.kind === 'unavailable') return count ? <p className={className}>{count}</p> : null;
  return <div className={cn('flex flex-wrap items-center gap-x-4 gap-y-2', className)}>
    {adapter.kind === 'signed-out'
      ? <Link href={adapter.signInHref} className={cn(buttonVariants({ pill: true }), 'min-w-32')}>
        <PlusIcon aria-hidden="true" />{t.follow}<span className="sr-only"> — {t.signInToFollow}</span></Link>
      // The label says the state; while following, its hidden end says what a press does. A press while
      // the last one is saving is ignored, so the button says it is unavailable until then.
      : <Button pill variant={state.following ? 'outline' : 'default'} className="min-w-32"
        aria-disabled={status === 'saving' || undefined} onClick={() => void toggle()}>
        {state.following ? <><CheckIcon aria-hidden="true" className="text-primary" />{t.following}
          <span className="sr-only"> · {t.unfollowName({ name })}</span></>
          : <><PlusIcon aria-hidden="true" />{t.follow}<span className="sr-only"> · {name}</span></>}</Button>}
    {count}
    {status === 'failed' ? <p role="status" className="basis-full text-destructive-foreground text-sm">
      {t.followFailed}</p> : null}
  </div>;
}
