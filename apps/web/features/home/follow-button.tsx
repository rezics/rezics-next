'use client';

import { RelationshipControl } from '../relationships/control.tsx';
import { useFeed } from '../feed/feed-context.tsx';

/** Home uses the same relationship commands and state as headers, posts and the follows manager. */
export function FollowButton({ target, kind, realm, label, followLabel, followedLabel, name }: {
  target: string; kind: string; realm: string; label: string; followLabel: string; followedLabel: string;
  failedLabel: string;
  name?: string;
}) {
  const { locale, signedIn, actingSubject, signInHref, markFollowed, realmState } = useFeed();
  return <RelationshipControl target={target} kind={kind} realm={realm} name={name ?? label} locale={locale}
    signedIn={signedIn} actingSubject={actingSubject} signInHref={signInHref} compact
    followLabel={followLabel} followingLabel={followedLabel} followAccessibleLabel={label}
    initial={realmState(realm) === 'following' ? { following: true, revision: null, level: null, source: null, pinPosition: null } : null}
    onChange={state => markFollowed(realm, state.following === true)} />;
}
