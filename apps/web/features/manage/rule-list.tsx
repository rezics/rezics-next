import { Badge } from '@rezics/ui/badge';
import { cn } from '@rezics/ui/utils';
import { LanguagesIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import { localeNames, type UiLocale } from '../../i18n/define.ts';
import type { ManageMessages } from './messages.ts';
import { type RuleLanguage, type RuleMeaning, shownRule } from './rules.ts';
import type { RealmRule } from './types.ts';

export function ruleLanguageName(language: RuleLanguage, t: Pick<ManageMessages, 'languageEnglish' | 'languageChinese' | 'languageUnknown'>, locale: UiLocale = 'en') {
  if (language === 'und') return t.languageUnknown;
  if (language === 'en') return t.languageEnglish;
  if (language === 'zh-Hans') return t.languageChinese;
  try { return new Intl.DisplayNames([locale], { type: 'language' }).of(language) ?? language; }
  catch { return language; }
}

/** The published revision the rules below belong to, whatever language they are read in. */
export function RevisionBadge({ meaning, locale, messages }: { meaning: RuleMeaning; locale: UiLocale; messages: ManageMessages }) {
  const t = materializeData(messages, { locale });
  return <Badge variant={meaning.revision ? 'soft' : 'secondary'} title={meaning.digest ?? undefined}>
    {meaning.revision ? t.rulesRevision({ revision: meaning.revision }) : t.rulesUnpublished}</Badge>;
}

/**
 * Rules as a reader of `locale` sees them. Text carries the language it is
 * written in; when that is not the reader's, the rule says which it shows.
 */
export function RuleList({ rules, locale, messages, className }: {
  rules: readonly RealmRule[]; locale: UiLocale; messages: ManageMessages; className?: string;
}) {
  const t = materializeData(messages, { locale });
  return <ol className={cn('grid gap-3', className)}>
    {rules.map((rule, index) => {
      const shown = shownRule(rule, locale);
      return <li key={rule.id} className="flex gap-4 rounded-2xl border border-border/60 bg-card p-4">
        <span aria-hidden="true" className="grid size-7 shrink-0 place-items-center rounded-full bg-primary/10 font-semibold
          text-primary text-sm">{index + 1}</span>
        <div className="grid min-w-0 gap-1">
          <h3 lang={shown.title.lang} dir="auto" className="font-semibold">
            <span className="sr-only">{t.ruleNumber({ number: String(index + 1) })}: </span>{shown.title.text}</h3>
          <p lang={shown.body.lang} dir="auto" className="whitespace-pre-line text-pretty text-muted-foreground text-sm
            leading-relaxed">{shown.body.text}</p>
          {shown.title.fallback ? <p className="flex items-center gap-1.5 text-muted-foreground text-xs">
            <LanguagesIcon aria-hidden="true" className="size-3.5" />
            {t.shownInFallback({ requested: localeNames[locale], language: ruleLanguageName(shown.title.fallback, t, locale) })}</p>
            : null}
        </div>
      </li>;
    })}
  </ol>;
}
