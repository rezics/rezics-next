'use client';

import { buttonVariants } from '@rezics/ui/button';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@rezics/ui/input-group';
import { Popover, PopoverBody, PopoverContent, PopoverHeader, PopoverTrigger } from '@rezics/ui/popover';
import { cn } from '@rezics/ui/utils';
import { CheckIcon, ChevronsUpDownIcon, PlusIcon, SearchIcon } from 'lucide-react';
import { useId, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { LanguageName } from '../onboarding/language-picker.tsx';
import { matchingLanguages } from '../onboarding/languages.ts';
import { contentLanguageText as words } from './messages.ts';
import { suggestedLanguages, UNSPECIFIED } from './writing-language.ts';

const option = cn('flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-start outline-none transition-colors',
  'hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring aria-[current=true]:bg-primary/10');

/**
 * The language one piece of writing is in, chosen by its writer. Suggestions
 * are what the writer reads, what the text is in now and its original; any
 * other language is found by name or typed as a BCP 47 code. The interface
 * locale only names the languages, it is never the choice.
 */
export function LanguageSelect({ value, onChange, locale, reading = [], original = null, placeholder, label, id,
  disabled = false, className }: {
  /** The chosen language, or null to show `placeholder` as an action that adds one. */
  value: string | null; onChange: (language: string) => void; locale: UiLocale;
  placeholder?: string;
  /** The writer's saved reading languages, first choice first. */
  reading?: readonly string[];
  /** The language the text was first written in, when this is a translation of it. */
  original?: string | null;
  /** What the language is of, for example "Language of your review"; defaults to "Language". */
  label?: string; id?: string; disabled?: boolean; className?: string;
}) {
  const t = { language: words.language[locale], notSpecified: words.notSpecified[locale], search: words.search[locale],
    searchHint: words.searchHint[locale], suggested: words.suggested[locale], noMatch: words.noMatch[locale] };
  const names = new Intl.DisplayNames([locale], { type: 'language', fallback: 'none' });
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const typed = query.trim().length > 0;
  const results = typed ? matchingLanguages(query, locale, []) : suggestedLanguages({ reading, current: value, original }).filter(tag => tag !== UNSPECIFIED || value !== null);
  // `Intl` refuses private-use (`x-…`) and grandfathered (`i-…`) tags, which Main keeps: show the tag itself.
  const ownName = (tag: string) => {
    try { return new Intl.DisplayNames([tag], { type: 'language', fallback: 'code' }).of(tag) ?? null; }
    catch { return null; }
  };
  const nameOf = (tag: string) => tag === UNSPECIFIED ? t.notSpecified : ownName(tag) ?? tag;
  const pick = (tag: string) => { onChange(tag); setOpen(false); setQuery(''); };
  const caption = label ?? t.language;
  return <Popover open={open} onOpenChange={details => { setOpen(details.open); if (!details.open) setQuery(''); }}>
    <PopoverTrigger id={id} type="button" disabled={disabled} aria-label={value === null ? caption : `${caption}: ${nameOf(value)}`}
      className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'max-w-full justify-between gap-2', className)}>
      {value === null ? <><PlusIcon aria-hidden="true" className="size-4 shrink-0" />
        <span className="truncate">{placeholder ?? caption}</span></>
        : <><span lang={value !== UNSPECIFIED && ownName(value) ? value : undefined} className="truncate">{nameOf(value)}</span>
          <ChevronsUpDownIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" /></>}
    </PopoverTrigger>
    <PopoverContent className="w-80 max-w-[calc(100vw-2rem)]">
      <PopoverHeader title={caption} />
      <PopoverBody className="grid gap-3">
        <InputGroup>
          <InputGroupAddon><SearchIcon aria-hidden="true" /></InputGroupAddon>
          <InputGroupInput type="search" value={query} autoFocus aria-label={t.search} placeholder={t.searchHint}
            onChange={event => setQuery(event.currentTarget.value)}
            onKeyDown={event => {
              if (event.key !== 'Enter') return;
              // Enter never submits the form the select sits in.
              event.preventDefault();
              if (!event.nativeEvent.isComposing && results[0]) pick(results[0]);
            }} />
        </InputGroup>
        {typed && !results.length ? <p role="status" className="text-muted-foreground text-sm">{t.noMatch}</p>
          : <div className="grid gap-1">
            {typed ? null : <p id={`${listId}-suggested`} className="px-1 font-semibold text-muted-foreground text-xs">
              {t.suggested}</p>}
            <ul aria-labelledby={typed ? undefined : `${listId}-suggested`} aria-label={typed ? t.search : undefined}
              className="grid max-h-64 gap-0.5 overflow-auto">
              {results.map(tag => <li key={tag}>
                <button type="button" className={option} aria-current={tag === value ? true : undefined} onClick={() => pick(tag)}>
                  {tag === UNSPECIFIED ? <span className="min-w-0 flex-1 truncate">{t.notSpecified}</span>
                    : <LanguageName tag={tag} names={names} />}
                  {tag === value ? <CheckIcon aria-hidden="true" className="size-4 shrink-0 text-primary" />
                    : tag === UNSPECIFIED ? null
                      : <span className="font-normal text-muted-foreground text-xs">{tag}</span>}
                </button>
              </li>)}
            </ul>
          </div>}
      </PopoverBody>
    </PopoverContent>
  </Popover>;
}
