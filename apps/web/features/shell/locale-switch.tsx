import { cn } from '@rezics/ui/utils';
import type { UiLocale } from '../../i18n/define.ts';

// Each language names itself, so it reads the same in either interface locale.
const choices: readonly { locale: UiLocale; label: string }[] = [
  { locale: 'en', label: 'English' }, { locale: 'zh-CN', label: '简体中文' }];

export const segmentClass = cn('inline-flex h-8 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-lg px-2.5',
  'font-medium text-muted-foreground text-xs outline-none transition-colors hover:text-foreground',
  'focus-visible:ring-2 focus-visible:ring-ring',
  'aria-pressed:bg-card aria-pressed:text-foreground aria-pressed:shadow-(--aura-shadow-card)');

/** Posts the choice to /locale/select, which stores it and returns to this page. Works without JavaScript. */
export function LocaleSwitch({ locale, label }: { locale: UiLocale; label: string }) {
  return <form method="post" action="/locale/select" aria-label={label}
    className="flex gap-1 rounded-xl bg-muted p-1">
    {choices.map(choice => <button key={choice.locale} type="submit" name="locale" value={choice.locale}
      lang={choice.locale} aria-pressed={locale === choice.locale} className={segmentClass}>
      {choice.label}</button>)}
  </form>;
}
