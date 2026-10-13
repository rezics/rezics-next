'use client';

import { useRouter } from 'next/navigation';
import { materializeData } from 'native-i18n';
import { useEffect, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { useReaderActions } from '../catalogue/reader-actions.tsx';
import Link from '../shell/localized-link.tsx';
import { EDITION_SAVED, PreferenceForm, usePreferenceSubject } from '../tracking/series-progress-panel.tsx';
import { copyOf } from '../tracking/messages.ts';
import type { TrackingApi } from '../tracking/api.ts';
import type { EditionPreference, Editions } from '../tracking/types.ts';
import type { WorkPageMessages } from './messages.ts';

interface Setup { work: string; api: TrackingApi; preference: EditionPreference | null; editions: Editions | null;
  failure: 'sign-in' | 'unavailable' | null }

/**
 * The reader's private edition choice for this Work, where it is made: the language and the realization or
 * release that counts as theirs, saved against the version read (another device's change is shown, never
 * overwritten). Main's progress summary and the page's primary action use it, so a save refreshes the server
 * parts of the page and tells the series panel. Signed out, it says what signing in unlocks.
 */
export function YourEdition({ work, signInHref, locale, messages }: {
  /** The Work's IRI. */
  work: string; signInHref: string; locale: UiLocale; messages: WorkPageMessages;
}) {
  const actions = useReaderActions();
  const api = actions.kind === 'ready' ? actions.tracking ?? null : null;
  const t = materializeData(messages, { locale });
  const router = useRouter();
  const [setup, setSetup] = useState<Setup | null>(null);
  const [language, setLanguage] = useState<string>(locale);
  const subject = usePreferenceSubject(work, api,
    setup?.work === work && setup.api === api ? setup.preference?.version ?? 0 : 0);
  useEffect(() => {
    if (!api) return;
    let current = true;
    const owner = subject.capture();
    void Promise.all([api.preference(work), api.editions(work)]).then(([saved, offered]) => {
      if (!current || !subject.applies(owner)) return;
      const preference = saved.ok ? saved.data : null;
      setLanguage(preference?.language ?? locale);
      setSetup({ work, api, preference, editions: offered.ok ? offered.data : null,
        failure: saved.ok ? null : saved.failure === 'sign-in' ? 'sign-in' : 'unavailable' });
    });
    return () => { current = false; };
  }, [api, work, locale]);
  if (actions.kind === 'signed-out') {
    return <p className="text-muted-foreground text-sm">
      <Link href={signInHref} className="text-primary underline underline-offset-4 hover:no-underline">{t.signInForEdition}</Link></p>;
  }
  if (!api) return null;
  if (!setup || setup.work !== work || setup.api !== api)
    return <p role="status" aria-busy="true" className="text-muted-foreground text-sm">{t.loadingRegion}</p>;
  if (setup.failure) return <p role="alert" className="text-muted-foreground text-sm">
    {setup.failure === 'sign-in' ? t.regionDenied : t.regionUnavailable}</p>;
  const owner = subject.capture();
  return <div data-your-edition className="min-w-0 [&_[data-part=value-text]]:min-w-0 [&_[data-part=value-text]]:[overflow-wrap:anywhere]">
    <PreferenceForm key={work} work={work} preference={setup.preference} language={language} editions={setup.editions} api={api}
      locale={locale} t={copyOf(locale)} onLanguage={setLanguage}
      onSaved={preference => {
        if (!subject.applies(owner) || preference && preference.work !== work) return;
        setSetup(current => current?.work === work && current.api === api && (current.preference?.version ?? 0) === owner.version
          ? { ...current, preference } : current);
        window.dispatchEvent(new CustomEvent(EDITION_SAVED, { detail: { work, preference } }));
        // The primary action and the status lines are read on the server; they follow the choice.
        router.refresh();
      }} />
  </div>;
}
