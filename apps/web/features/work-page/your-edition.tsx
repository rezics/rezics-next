'use client';

import { useRouter } from 'next/navigation';
import { materializeData } from 'native-i18n';
import { useEffect, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { useReaderActions } from '../catalogue/reader-actions.tsx';
import Link from '../shell/localized-link.tsx';
import { EDITION_SAVED, PreferenceForm } from '../tracking/series-progress-panel.tsx';
import { copyOf } from '../tracking/messages.ts';
import type { EditionPreference, Editions } from '../tracking/types.ts';
import type { WorkPageMessages } from './messages.ts';

interface Setup { preference: EditionPreference | null; editions: Editions | null }

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
  useEffect(() => {
    if (!api) return;
    let current = true;
    void Promise.all([api.preference(work), api.editions(work)]).then(([saved, offered]) => {
      if (!current) return;
      const preference = saved.ok ? saved.data : null;
      if (preference) setLanguage(preference.language);
      setSetup({ preference, editions: offered.ok ? offered.data : null });
    });
    return () => { current = false; };
  }, [api, work]);
  if (actions.kind === 'signed-out') {
    return <p className="text-muted-foreground text-sm">
      <Link href={signInHref} className="text-primary underline-offset-4 hover:underline">{t.signInForEdition}</Link></p>;
  }
  if (!api || !setup) return null;
  return <div data-your-edition>
    <PreferenceForm work={work} preference={setup.preference} language={language} editions={setup.editions} api={api}
      locale={locale} t={copyOf(locale)} onLanguage={setLanguage}
      onSaved={preference => {
        setSetup(current => current ? { ...current, preference } : current);
        window.dispatchEvent(new CustomEvent(EDITION_SAVED, { detail: { work, preference } }));
        // The primary action and the status lines are read on the server; they follow the choice.
        router.refresh();
      }} />
  </div>;
}
