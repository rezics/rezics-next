'use client';

import { Button } from '@rezics/ui/button';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/native-select';
import { SearchIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import { useRouter } from 'next/navigation';
import { type FormEvent, type KeyboardEvent, useId, useRef, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import type { SearchMessages } from './messages.ts';
import { normalizePhrase, PHRASE, phraseStatus, type SearchScope, type SearchState, searchHref } from './state.ts';
import { TypeaheadInput, type TypeaheadLoader } from './typeahead.tsx';

/** A Realm the selector offers: the one in the URL, named when Main could name it. */
export interface RealmOption { id: string; label: string; lang?: string }

/**
 * The query box with its scope beside it and title suggestions under it.
 * Submitting or changing the scope moves the URL, which the server renders.
 * Enter that commits an IME composition (Chinese, Japanese, Korean input)
 * never submits.
 */
export function SearchForm({ state, realm, load, locale, messages }: {
  state: SearchState; realm: RealmOption | null;
  /** Title suggestions; Main's typeahead through the BFF by default, a fixture in stories. */
  load?: TypeaheadLoader;
  locale: UiLocale; messages: SearchMessages;
}) {
  const t = materializeData(messages, { locale });
  const router = useRouter();
  const scopeId = useId();
  const input = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const [scope, setScope] = useState<'global' | 'realm'>(state.scope.kind);
  const selected = (value: 'global' | 'realm'): SearchScope =>
    value === 'realm' && realm ? { kind: 'realm', realm: realm.id } : { kind: 'global' };

  function go(phrase: string, value: 'global' | 'realm') {
    router.push(localizedPath(searchHref({ ...state, phrase, scope: selected(value) }), locale));
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (composing.current) return;
    const phrase = normalizePhrase(input.current?.value ?? '');
    if (phraseStatus(phrase) === 'ok') go(phrase, scope);
    else input.current?.reportValidity();
  }
  function keyDown(event: KeyboardEvent<HTMLInputElement>) {
    // Safari reports the committing Enter with isComposing false but keyCode 229.
    if (event.key === 'Enter' && (event.nativeEvent.isComposing || composing.current || event.keyCode === 229)) {
      event.preventDefault();
    }
  }

  return <form role="search" aria-label={t.form} action={localizedPath('/search', locale)} method="get" onSubmit={submit}
    className="flex flex-col gap-2 sm:flex-row">
    <label htmlFor={scopeId} className="sr-only">{t.scopeLabel}</label>
    {/* Without JavaScript the form submits natively; everyone's scope is the default, so it adds nothing. */}
    <NativeSelect id={scopeId} name={scope === 'realm' ? 'scope' : undefined} size="lg" value={scope} className="w-full sm:w-auto sm:max-w-80 [&_select]:h-12
      [&_select]:rounded-2xl [&_select]:bg-card" onChange={event => {
      const value = event.target.value === 'realm' ? 'realm' : 'global';
      setScope(value);
      const phrase = normalizePhrase(input.current?.value ?? '');
      if (phraseStatus(phrase) === 'ok') go(phrase, value);
    }}>
      <NativeSelectOption value="global">{t.global}</NativeSelectOption>
      {realm ? <NativeSelectOption value="realm" lang={realm.lang}>{realm.label}</NativeSelectOption> : null}
    </NativeSelect>
    {realm && scope === 'realm' ? <input type="hidden" name="realm" value={realm.id} /> : null}
    {state.language ? <input type="hidden" name="lang" value={state.language} /> : null}
    {state.term ? <input type="hidden" name="term" value={state.term} /> : null}
    {state.includeTypes?.length ? <input type="hidden" name="include" value={state.includeTypes.join(',')} /> : null}
    {state.excludeTypes?.length ? <input type="hidden" name="exclude" value={state.excludeTypes.join(',')} /> : null}
    <div className="relative flex-1">
      <SearchIcon aria-hidden="true" className="pointer-events-none absolute start-4 top-1/2 size-5 -translate-y-1/2
        text-muted-foreground" />
      <TypeaheadInput ref={input} key={state.phrase} locale={locale} load={load} name="q" type="search"
        defaultValue={state.phrase} required minLength={PHRASE.min} maxLength={PHRASE.max} aria-label={t.phraseLabel}
        placeholder={t.placeholder} autoComplete="off" enterKeyHint="search" onKeyDown={keyDown}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={() => { composing.current = false; }}
        className="h-12 rounded-2xl bg-card ps-12 text-base md:text-base" />
    </div>
    <Button type="submit" size="xl" className="h-12">{t.search}</Button>
  </form>;
}
