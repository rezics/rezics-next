'use client';

import { ChoiceSelect } from '@rezics/ui/select';
import { useRef, useState } from 'react';
import { localeNames, uiLocales, type UiLocale } from '../../i18n/define.ts';

/** The signed-out header keeps language choice directly available. */
export function LocaleSelect({ locale, label }: { locale: UiLocale; label: string }) {
  const [selected, setSelected] = useState<UiLocale>(locale);
  const form = useRef<HTMLFormElement>(null);
  const input = useRef<HTMLInputElement>(null);
  return <>
    <form ref={form} data-locale-js method="post" action="/locale/select" aria-label={label}>
      <input ref={input} type="hidden" name="locale" value={selected} />
      <ChoiceSelect value={selected} label={label} className="h-9 max-w-30 sm:max-w-none"
        options={uiLocales.map(choice => ({ value: choice, label: localeNames[choice], lang: choice }))}
        onValueChange={value => {
          if (value === selected) return;
          setSelected(value as UiLocale);
          if (input.current) input.current.value = value;
          form.current?.requestSubmit();
        }} />
    </form>
    <noscript>
      <style>{'[data-locale-js] { display: none !important; }'}</style>
      <details className="relative text-sm">
        <summary className="cursor-pointer rounded-lg border border-border/60 px-3 py-2">{localeNames[locale]}</summary>
        <form method="post" action="/locale/select" aria-label={label}
          className="absolute end-0 z-50 mt-1 grid min-w-40 rounded-2xl border border-border/60 bg-popover p-1.5 shadow-lg">
          {uiLocales.map(choice => <button key={choice} type="submit" name="locale" value={choice} lang={choice}
            aria-current={choice === locale ? 'true' : undefined}
            className="rounded-xl px-3 py-2 text-start text-popover-foreground hover:bg-accent">
            {localeNames[choice]}</button>)}
        </form>
      </details>
    </noscript>
  </>;
}
