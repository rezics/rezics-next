'use client';

import { localeNames, uiLocales, type UiLocale } from '../../i18n/define.ts';

/** The signed-out header keeps language choice directly available. */
export function LocaleSelect({ locale, label }: { locale: UiLocale; label: string }) {
  return <form method="post" action="/locale/select" aria-label={label}>
    <select name="locale" aria-label={label} value={locale}
      onChange={event => event.currentTarget.form?.requestSubmit()}
      className="h-9 max-w-30 rounded-lg border border-border/60 bg-background px-2 text-sm text-foreground
        outline-none focus-visible:ring-2 focus-visible:ring-ring sm:max-w-none">
      {uiLocales.map(choice => <option key={choice} value={choice} lang={choice}>
        {localeNames[choice]}</option>)}
    </select>
    <button type="submit" className="sr-only">{label}</button>
  </form>;
}
