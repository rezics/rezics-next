'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { SearchSelection, searchQueryOptions } from './query.ts';
import { SearchResults } from './search-results.tsx';
import type { search as EnglishSearch } from '../../i18n/en.ts';
import type { UiLocale } from '../../i18n/resources.ts';

export function SearchExplorer({ initialPhrase, locale, messages }: { initialPhrase: string;
  locale: UiLocale; messages: typeof EnglishSearch }) {
  const [language, setLanguage] = useState<string | null>(null);
  const [realmId, setRealmId] = useState('');
  const [context, setContext] = useState<'global' | 'realm'>('global');
  const selection: SearchSelection = { phrase: initialPhrase,
    context: context === 'realm' ? { kind: 'realm', id: realmId } : { kind: 'global' }, language };
  const validRealm = context === 'global' || /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(realmId);
  const query = useQuery({ ...searchQueryOptions(selection),
    enabled: validRealm && initialPhrase.trim().length >= 2 });
  const results = query.data?.results ?? [];
  const filters = (group: string) => <><fieldset className="filter-group"><legend>{messages.language}</legend>
    {[[null, messages.anyLanguage], ['en', messages.english], ['es', messages.spanish],
      ['ja', messages.japanese]].map(([value, label]) =>
      <label className="filter-row" key={label}><input type="radio" name={group} checked={language === value}
        onChange={() => setLanguage(value)} />{label}</label>)}</fieldset>
    <p className="muted">{messages.languageHelp}</p></>;

  return <>
    <section className="search-intro" aria-labelledby="search-title">
      <div><h1 id="search-title" className="page-title">{messages.title}</h1>
        <p className="search-phrase">{initialPhrase ? `“${initialPhrase}”` : messages.emptyPhrase}</p></div>
      <div className="perspective-box">
        <label htmlFor="perspective">{messages.perspectiveLabel}</label>
        <select className="select-control" id="perspective" value={context}
          onChange={event => setContext(event.target.value as 'global' | 'realm')}>
          <option value="global">{messages.globalPerspective}</option>
          <option value="realm">{messages.realmPerspective}</option>
        </select>
        {context === 'realm' ? <label htmlFor="realm-id" className="realm-input-label">
          {messages.realmId}<input id="realm-id" value={realmId} onChange={event => setRealmId(event.target.value)}
            placeholder="https://rezics.com/id/…" /></label> : null}
        <p>{messages.perspectiveHelp}</p>
      </div>
    </section>
    <div className="search-layout">
      <aside className="filter-rail" aria-label={messages.filters}>
        <div className="filter-desktop">{filters('language-desktop')}</div>
        <details className="filter-mobile"><summary>{messages.filterResults}</summary>{filters('language-mobile')}</details>
      </aside>
      <div>
        {!validRealm ? <p className="state-panel">{messages.invalidRealm}</p> : null}
        <SearchResults total={query.data?.total} sequence={query.data?.sourcePosition.sequence}
          results={results} state={!validRealm ? 'blocked' : initialPhrase.trim().length < 2 ? 'idle'
            : query.isError ? 'error' : query.isSuccess ? 'ready' : 'loading'}
          error={query.error?.message} locale={locale} messages={messages} />
      </div>
    </div>
  </>;
}
