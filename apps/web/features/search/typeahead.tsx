'use client';

import { Input, type InputProps } from '@rezics/ui/input';
import { cn } from '@rezics/ui/utils';
import { WorkCover } from '@rezics/ui/work-cover';
import { materializeData } from 'native-i18n';
import { useRouter } from 'next/navigation';
import { type CompositionEvent, type FocusEvent, type InputEvent, type KeyboardEvent, type Ref, useEffect, useId,
  useRef, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { browserMainApi } from '../api/browser.ts';
import { coverImage } from '../catalogue/work.ts';
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
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const composing = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const asked = useRef(0);
  const answers = useRef(new Map<string, readonly TypeaheadItem[]>());
  useEffect(() => () => clearTimeout(timer.current), []);

  function show(next: readonly TypeaheadItem[]) {
    setItems(next);
    setActive(-1);
    setOpen(next.length > 0);
  }
  function suggest(value: string) {
    clearTimeout(timer.current);
    const prefix = typeaheadPrefix(value);
    const request = ++asked.current;
    if (!prefix) { show([]); return; }
    const known = answers.current.get(`${locale}\u0000${prefix}`);
    if (known) { show(known); return; }
    // Wait for a pause in typing; an answer to an older prefix is dropped.
    timer.current = setTimeout(() => {
      load(prefix, locale).then(found => {
        answers.current.set(`${locale}\u0000${prefix}`, found);
        if (request === asked.current && !composing.current) show(found);
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
        const hint = item.matchedField === 'credit' ? t.byAuthor({ name: item.matchedText })
          : item.matchedText !== item.title.value ? t.alsoTitled({ title: item.matchedText }) : null;
        return <li key={`${item.work}-${item.matchedField}-${item.matchedText}`} id={`${listId}-${index}`} role="option"
          aria-selected={index === active}
          // Keep focus in the box, so the list stays open until the click chooses.
          onMouseDown={event => event.preventDefault()} onClick={() => choose(item)}
          onMouseMove={() => setActive(index)}
          className={cn('flex cursor-pointer items-center gap-3 rounded-xl px-2 py-1.5 text-start',
            'aria-selected:bg-accent aria-selected:text-accent-foreground')}>
          <WorkCover title={item.title.value} lang={item.title.language} size="xs"
            seed={item.cover.kind === 'fallback' ? item.cover.key : item.work} image={coverImage(item.cover)} />
          <span className="grid min-w-0">
            <span lang={item.title.language} dir={item.title.direction}
              className="truncate font-medium font-work-title text-[0.9375rem]">{item.title.value}</span>
            {hint ? <span lang={item.matchedLanguage ?? undefined}
              className="truncate text-muted-foreground text-xs">{hint}</span> : null}
          </span>
        </li>;
      })}
    </ul> : null}
    <span role="status" className="sr-only">{open ? t.found(items.length) : ''}</span>
  </div>;
}
