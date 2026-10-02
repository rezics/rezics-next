'use client';

import { useFeed } from './feed-context.tsx';
import type { FeedItem } from './types.ts';
import { RelationshipControl } from '../relationships/control.tsx';

export function FollowRealmButton({ realm }: { realm: NonNullable<FeedItem['realm']> }) {
  const { locale, t, signedIn, actingSubject, signInHref, realmState, markFollowed } = useFeed();
  return <RelationshipControl target={realm.id} kind="realm" realm={realm.id} name={realm.name.value} locale={locale}
    signedIn={signedIn} actingSubject={actingSubject} signInHref={signInHref} compact
    followAccessibleLabel={t.followRealm({ realm: realm.name.value })}
    initial={realmState(realm.id) === 'follow' ? { following: false, revision: null, level: null, source: null, pinPosition: null } : null}
    onChange={state => markFollowed(realm.id, state.following === true)} />;
}
