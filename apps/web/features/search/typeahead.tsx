'use client';

import { Input, type InputProps } from '@rezics/ui/input';
import { cn } from '@rezics/ui/utils';
import { materializeData } from 'native-i18n';
import { useRouter } from 'next/navigation';
import { type CompositionEvent, type FocusEvent, type InputEvent, type KeyboardEvent, type Ref, useEffect, useId,
  useRef, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { browserMainApi } from '../api/browser.ts';
import { CatalogueCover } from '../catalogue/cover.tsx';
import { messages as catalogueMessages } from '../catalogue/messages.ts';
import { coverKindOf, workTypeLabel } from '../catalogue/work.ts';
import { normalizePhrase, PHRASE } from './state.ts';
import { isWideText, type TypeaheadItem } from './suggest.ts';
import { typeaheadMessages } from './typeahead-messages.ts';

/** Suggestions for one prefix; the stories and tests supply their own. */
export type TypeaheadLoader = (prefix: string, locale: UiLocale) => Promise<TypeaheadItem[]>;

const mainTypeahead: TypeaheadLoader = async (prefix, language) => {
  const { data } = await browserMainApi().v1.search.typeahead.get({ query: { prefix, language } });
  return data?.items ?? [];
};

/** A prefix worth asking for: one CJK character already names a title's start; Latin text needs two letters. */
export function typeaheadPrefix(value: string): string | null {
  const phrase = normalizePhrase(value);
  const length = [...phrase].length;
  if (!length || length > PHRASE.max) return null;
  return length >= (isWideText(phrase) ? 1 : 2) ? phrase : null;
}

/** Where a suggestion leads: its Work, or a search for the credited name that matched. */
export function suggestionHref(item: TypeaheadItem): string {
  return item.matchedField === 'credit' ? `/search?q=${encodeURIComponent(item.matchedText)}`
    : `/w/${item.work.slice(-36)}`;
}

/**
 * Text with the part the reader typed marked, matched without regard to
 * case. Text whose lower case changes its length is left unmarked rather
 * than marked in the wrong place.
 */
export function Highlighted({ text, phrase }: { text: string; phrase: string }) {
  const folded = text.toLocaleLowerCase();
  const at = phrase && folded.length === text.length ? folded.indexOf(phrase.toLocaleLowerCase()) : -1;
  if (at < 0) return text;
  return <>{text.slice(0, at)}<mark className="rounded-[0.1875rem] bg-primary/12 font-semibold text-inherit">
    {text.slice(at, at + phrase.length)}</mark>{text.slice(at + phrase.length)}</>;
}

const composingKey = (event: KeyboardEvent<HTMLInputElement>) =>
  // Safari reports the Enter that commits a composition with isComposing false but keyCode 229.
  event.nativeEvent.isComposing || event.keyCode === 229;

/**
 * A search box that suggests Works as the reader types: titles first, then
 * credited names, as Main's typeahead ranks them. It is an ARIA combobox:
 * ↑ and ↓ choose a suggestion, Enter opens it, Escape closes the list, and
 * Enter with nothing chosen submits the form as before. While an input method
 * composes CJK text nothing is asked and no key is taken, so the reader sees
 * suggestions for the characters they commit, not for the romanization.
 */
export function TypeaheadInput({ locale, load = mainTypeahead, ref, onKeyDown, onCompositionStart, onCompositionEnd,
  onFocus, onBlur, onInput, className, ...props }: Omit<InputProps, 'role'> & {
  locale: UiLocale; load?: TypeaheadLoader; ref?: Ref<HTMLInputElement>;
}) {
  const t = materializeData(typeaheadMessages[locale], { locale });
  const router = useRouter();
  const listId = useId();
  const [items, setItems] = useState<readonly TypeaheadItem[]>([]);
  const [phrase, setPhrase] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const composing = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const asked = useRef(0);
  const answers = useRef(new Map<string, readonly TypeaheadItem[]>());
  useEffect(() => () => clearTimeout(timer.current), []);

  function show(next: readonly TypeaheadItem[], typed = '') {
    setItems(next);
    setPhrase(typed);
    setActive(-1);
    setOpen(next.length > 0);
  }
  function suggest(value: string) {
    clearTimeout(timer.current);
    const prefix = typeaheadPrefix(value);
    const request = ++asked.current;
    if (!prefix) { show([]); return; }
    const known = answers.current.get(`${locale}\u0000${prefix}`);
    if (known) { show(known, prefix); return; }
    // Wait for a pause in typing; an answer to an older prefix is dropped.
    timer.current = setTimeout(() => {
      load(prefix, locale).then(found => {
        answers.current.set(`${locale}\u0000${prefix}`, found);
        if (request === asked.current && !composing.current) show(found, prefix);
      }, () => { if (request === asked.current) show([]); });
    }, 150);
  }
  function choose(item: TypeaheadItem) {
    setOpen(false);
    router.push(localizedPath(suggestionHref(item), locale));
  }

  function keyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (!composing.current && !composingKey(event)) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (items.length) {
          event.preventDefault();
          const step = event.key === 'ArrowDown' ? 1 : -1;
          setOpen(true);
          setActive(current => (current + step + items.length + (current < 0 && step < 0 ? 1 : 0)) % items.length);
        }
      } else if (event.key === 'Enter' && open && active >= 0 && items[active]) {
        event.preventDefault();
        choose(items[active]);
        return;
      } else if (event.key === 'Escape' && open) {
        event.preventDefault();
        setOpen(false);
        setActive(-1);
      } else if (event.key === 'Tab') setOpen(false);
    }
    onKeyDown?.(event);
  }

  const current = open && active >= 0 ? `${listId}-${active}` : undefined;
  return <div className="relative w-full">
    <Input {...props} ref={ref} role="combobox" aria-autocomplete="list" aria-expanded={open}
      aria-controls={open ? listId : undefined} aria-activedescendant={current} className={className}
      onKeyDown={keyDown}
      onInput={(event: InputEvent<HTMLInputElement>) => {
        onInput?.(event);
        if (!composing.current) suggest(event.currentTarget.value);
      }}
      onCompositionStart={(event: CompositionEvent<HTMLInputElement>) => {
        composing.current = true;
        onCompositionStart?.(event);
      }}
      onCompositionEnd={(event: CompositionEvent<HTMLInputElement>) => {
        composing.current = false;
        onCompositionEnd?.(event);
        suggest(event.currentTarget.value);
      }}
      onFocus={(event: FocusEvent<HTMLInputElement>) => {
        onFocus?.(event);
        if (items.length && typeaheadPrefix(event.currentTarget.value)) setOpen(true);
      }}
      onBlur={(event: FocusEvent<HTMLInputElement>) => {
        onBlur?.(event);
        setOpen(false);
      }} />
    {open ? <ul id={listId} role="listbox" aria-label={t.suggestions}
      className="absolute inset-x-0 top-full z-50 mt-2 grid max-h-[min(26rem,60dvh)] overflow-y-auto overscroll-contain
        rounded-2xl border border-border/70 bg-popover p-1.5 text-popover-foreground shadow-(--aura-shadow-card)">
      {items.map((item, index) => {
        const authors = item.authors.flatMap(author => author.displayName ? [author.displayName] : []);
        const type = workTypeLabel(item.types);
        // A credit that matched is named even when it is not among the Work's first authors.
        const credit = item.matchedField === 'credit' && !authors.includes(item.matchedText) ? item.matchedText : null;
        const byline = [...authors.slice(0, 2), ...credit ? [credit] : []];
        const also = item.matchedField === 'title' && item.matchedText !== item.title.value ? item.matchedText : null;
        return <li key={`${item.work}-${item.matchedField}-${item.matchedText}`} id={`${listId}-${index}`} role="option"
          aria-selected={index === active}
          // Keep focus in the box, so the list stays open until the click chooses.
          onMouseDown={event => event.preventDefault()} onClick={() => choose(item)}
          onMouseMove={() => setActive(index)}
          className={cn('flex cursor-pointer items-center gap-3 rounded-xl px-2 py-1.5 text-start',
            'aria-selected:bg-accent aria-selected:text-accent-foreground')}>
          <CatalogueCover work={{ id: item.work, title: item.title, cover: item.cover, kind: coverKindOf(item.types),
            authors }} size="xs" />
          <span className="grid min-w-0">
            <span lang={item.title.language} dir={item.title.direction}
              className="truncate font-medium font-work-title text-[0.9375rem]">
              <Highlighted text={item.title.value} phrase={phrase} /></span>
            {type || byline.length ? <span className="truncate text-muted-foreground text-xs">
              {type ? catalogueMessages[locale][type] : null}{type && byline.length ? ' · ' : null}
              {byline.length ? <Highlighted text={t.byAuthor({ name: new Intl.ListFormat(locale,
                { type: 'conjunction' }).format(byline) })} phrase={item.matchedField === 'credit' ? phrase : ''} />
                : null}</span> : null}
            {also ? <span lang={item.matchedLanguage ?? undefined} className="truncate text-muted-foreground text-xs">
              <Highlighted text={t.alsoTitled({ title: also })} phrase={phrase} /></span> : null}
          </span>
        </li>;
      })}
    </ul> : null}
    <span role="status" className="sr-only">{open ? t.found(items.length) : ''}</span>
  </div>;
}
