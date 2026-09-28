'use client';

import { Button } from '@rezics/ui/button';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@rezics/ui/input-group';
import { cn } from '@rezics/ui/utils';
import { ArrowUpIcon, PlusIcon, SearchIcon, XIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import { useId, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { added, earlier, matchingLanguages, MAX_LANGUAGES } from './languages.ts';
import type { OnboardingMessages } from './messages.ts';

type T = ReturnType<typeof materializeData<OnboardingMessages>>;

const suggestion = cn('flex min-h-12 w-full items-center gap-3 rounded-2xl border border-border/70 bg-background px-4',
  'text-start font-medium outline-none transition-colors hover:border-primary/40 hover:bg-accent/40',
  'focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60');

/** A language as its readers write it, with its name in the page's language beneath. */
function LanguageName({ tag, names }: { tag: string; names: Intl.DisplayNames }) {
  const own = new Intl.DisplayNames([tag], { type: 'language', fallback: 'code' }).of(tag) ?? tag;
  const local = names.of(tag);
  return <span className="grid min-w-0 flex-1">
    <span lang={tag} className="truncate">{own}</span>
    {local && local !== own ? <span className="truncate font-normal text-muted-foreground text-xs">{local}</span> : null}
  </span>;
}

/**
 * The content languages a reader reads, first choice first: any BCP 47
 * language, added from Main's suggestions or by name or code, and reordered
 * with the keyboard. Names on REZICS show in the first of these a Work has.
 */
export function LanguagePicker({ t, locale, suggested, value, onChange }: { t: T; locale: UiLocale;
  /** Main's suggestions for this locale. */
  suggested: readonly string[];
  value: readonly string[]; onChange: (languages: string[]) => void }) {
  const names = new Intl.DisplayNames([locale], { type: 'language', fallback: 'none' });
  const [query, setQuery] = useState('');
  const results = matchingLanguages(query, locale, value);
  const full = value.length >= MAX_LANGUAGES;
  const listId = useId();
  const add = (tag: string) => { onChange(added(value, tag)); setQuery(''); };
  return <div className="grid gap-6">
    <section aria-labelledby={`${listId}-chosen`} className="grid gap-2">
      <h3 id={`${listId}-chosen`} className="font-semibold">{t.yourLanguages}</h3>
      <p className="text-muted-foreground text-sm">{t.languagesOrder}</p>
      {value.length ? <ol className="grid gap-2 sm:max-w-xl">
        {value.map((tag, index) => {
          const name = names.of(tag) ?? tag;
          return <li key={tag} className="flex min-h-12 items-center gap-3 rounded-2xl border border-primary/40
            bg-primary/5 ps-4 pe-2">
            <span aria-hidden="true" className="grid size-6 shrink-0 place-items-center rounded-full bg-primary
              font-semibold text-primary-foreground text-xs tabular-nums">{index + 1}</span>
            <LanguageName tag={tag} names={names} />
            {index ? <Button variant="ghost" size="icon-sm" aria-label={t.moveEarlier({ language: name })}
              title={t.moveEarlier({ language: name })} onClick={() => onChange(earlier(value, tag))}>
              <ArrowUpIcon aria-hidden="true" /></Button> : null}
            <Button variant="ghost" size="icon-sm" aria-label={t.removeLanguage({ language: name })}
              title={t.removeLanguage({ language: name })} onClick={() => onChange(value.filter(item => item !== tag))}>
              <XIcon aria-hidden="true" /></Button>
          </li>;
        })}
      </ol> : <p className="text-muted-foreground text-sm">{t.allLanguages}</p>}
      {full ? <p role="status" className="text-muted-foreground text-sm">{t.languagesFull}</p> : null}
    </section>

    {suggested.some(tag => !value.includes(tag)) ? <section aria-labelledby={`${listId}-suggested`} className="grid gap-2">
      <h3 id={`${listId}-suggested`} className="font-semibold">{t.suggestedLanguages}</h3>
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {suggested.filter(tag => !value.includes(tag)).map(tag => <li key={tag}>
          <button type="button" disabled={full} className={suggestion} onClick={() => add(tag)}
            aria-label={t.addLanguageNamed({ language: names.of(tag) ?? tag })}>
            <LanguageName tag={tag} names={names} />
            <PlusIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          </button>
        </li>)}
      </ul>
    </section> : null}

    <section aria-labelledby={`${listId}-other`} className="grid gap-2 sm:max-w-xl">
      <h3 id={`${listId}-other`} className="font-semibold">{t.addLanguage}</h3>
      <InputGroup>
        <InputGroupAddon><SearchIcon aria-hidden="true" /></InputGroupAddon>
        <InputGroupInput type="search" value={query} disabled={full} aria-label={t.addLanguage}
          placeholder={t.addLanguageHint} onChange={event => setQuery(event.target.value)}
          onKeyDown={event => {
            if (event.key !== 'Enter' || event.nativeEvent.isComposing || !results[0]) return;
            event.preventDefault();
            add(results[0]);
          }} />
      </InputGroup>
      {query.trim() ? results.length ? <ul aria-label={t.addLanguage} className="grid gap-1">
        {results.map(tag => <li key={tag}><button type="button" className={cn(suggestion, 'min-h-11 rounded-xl')}
          onClick={() => add(tag)} aria-label={t.addLanguageNamed({ language: names.of(tag) ?? tag })}>
          <LanguageName tag={tag} names={names} />
          <span className="font-normal text-muted-foreground text-xs">{tag}</span>
        </button></li>)}
      </ul> : <p role="status" className="text-muted-foreground text-sm">{t.noLanguageMatch}</p> : null}
    </section>
  </div>;
}
