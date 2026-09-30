'use client';

import { Button } from '@rezics/ui/button';
import { CheckIcon } from 'lucide-react';
import { useState } from 'react';
import { commandKey } from '../feed/api.ts';
import { useFeed } from '../feed/feed-context.tsx';

/**
 * Follow one suggested Realm or Zone. Following a Zone follows its Realm too,
 * so the posts' Follow buttons change with it, and a Realm followed from a post
 * shows here as followed. Signed out, it leads to sign-in.
 */
export function FollowButton({ target, kind, realm, label, followLabel, followedLabel, failedLabel }: {
  target: string; kind: 'realm' | 'zone'; realm: string; label: string; followLabel: string; followedLabel: string;
  failedLabel: string;
}) {
  const { api, signedIn, actingSubject, signInHref, markFollowed, realmState } = useFeed();
  const [followed, setState] = useState<'idle' | 'busy' | 'following' | 'failed'>('idle');
  const state = followed === 'idle' && realmState(realm) === 'following' ? 'following' : followed;
  if (!signedIn) {
    return <a href={signInHref} aria-label={label} className="inline-flex h-8 shrink-0 items-center rounded-full
      bg-primary/10 px-3 font-medium text-primary text-sm outline-none hover:bg-primary/20 focus-visible:ring-2
      focus-visible:ring-ring">{followLabel}</a>;
  }
  if (!actingSubject) return null;
  if (state === 'following') {
    return <span className="inline-flex h-8 shrink-0 items-center gap-1 px-2 font-medium text-muted-foreground text-sm">
      <CheckIcon aria-hidden="true" className="size-4" />{followedLabel}</span>;
  }
  async function follow() {
    setState('busy');
    const result = await api().follow(target, kind, true, actingSubject!, commandKey());
    if (result.ok) markFollowed(realm, true);
    setState(result.ok ? 'following' : 'failed');
  }
  return <span className="grid shrink-0 justify-items-end gap-1">
    <Button size="sm" variant="soft" aria-label={label} isLoading={state === 'busy'} onClick={() => void follow()}
      className="h-8 rounded-full">{followLabel}</Button>
    {state === 'failed' ? <span role="status" className="text-destructive-foreground text-xs">{failedLabel}</span> : null}
  </span>;
}
