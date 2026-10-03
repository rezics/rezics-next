'use client';

import type { MainClient } from '../feed/types.ts';
import { useShell } from '../shell/shell-provider.tsx';
import { RelationshipWatch } from '../relationships/watch.tsx';

/** Proposal Watch shares the level menu and pending relationship feedback with every other target. */
export function WatchToggle({ proposal, main: _main, actingSubject }: { proposal: string; main?: MainClient; actingSubject?: string }) {
  const { locale, signedIn } = useShell();
  return <RelationshipWatch target={`urn:rezics:proposal:${proposal}`} kind="proposal" locale={locale} signedIn={signedIn}
    actingSubject={actingSubject} />;
}
