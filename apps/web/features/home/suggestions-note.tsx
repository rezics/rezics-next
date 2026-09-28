'use client';

import { Button } from '@rezics/ui/button';
import { SparklesIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { browserMainApi } from '../api/browser.ts';
import type { HomeMessages } from './messages.ts';

/** Turns Following's suggestions on or off in the reader's Home preferences, from their current revision. */
export async function saveRecommendations(actingSubject: string, on: boolean): Promise<boolean> {
  const main = browserMainApi();
  try {
    const read = await main.v1.me['feed-preferences'].get({ query: { actingSubject } });
    if (!read.data) return false;
    const written = await main.v1.me['feed-preferences'].put({ actingSubject, expectedRevision: read.data.revision,
      preferences: { ...read.data.preferences, recommendations: on } },
    { headers: { 'idempotency-key': crypto.randomUUID() } });
    return !written.error;
  } catch { return false; }
}

/**
 * Following fills a quiet page with labelled suggestions (frontend.md, Home);
 * this line says so and turns them off, or back on once they are off.
 */
export function SuggestionsNote({ locale, messages, on, actingSubject, save = saveRecommendations }: {
  locale: UiLocale; messages: HomeMessages; on: boolean; actingSubject: string;
  /** Stories: an in-memory preference write. */
  save?: (actingSubject: string, on: boolean) => Promise<boolean>;
}) {
  const t = materializeData(messages, { locale });
  const router = useRouter();
  const [state, setState] = useState<'idle' | 'busy' | 'failed'>('idle');
  async function toggle() {
    setState('busy');
    if (await save(actingSubject, !on)) { setState('idle'); router.refresh(); } else setState('failed');
  }
  return <p className="flex flex-wrap items-center gap-x-2 gap-y-1 border-border/60 border-b px-4 py-2
    text-muted-foreground text-sm">
    <SparklesIcon aria-hidden="true" className="size-4 shrink-0 text-info-foreground" />
    <span className="min-w-0 flex-1">{on ? t.suggestionsOn : t.suggestionsOff}</span>
    <Button size="sm" variant="ghost" className="h-7 px-2" isLoading={state === 'busy'} onClick={() => void toggle()}>
      {on ? t.turnOff : t.turnOn}</Button>
    {state === 'failed' ? <span role="status" className="basis-full text-destructive-foreground">
      {t.suggestionsFailed}</span> : null}
  </p>;
}
