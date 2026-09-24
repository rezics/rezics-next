'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { SearchSelection, searchQueryOptions } from './query.ts';
import { SearchResults } from './search-results.tsx';

export function SearchExplorer({ initialPhrase }: { initialPhrase: string }) {
  const [language, setLanguage] = useState<string | null>(null);
  const [realmId, setRealmId] = useState('');
  const [context, setContext] = useState<'global' | 'realm'>('global');
  const selection: SearchSelection = { phrase: initialPhrase,
    context: context === 'realm' ? { kind: 'realm', id: realmId } : { kind: 'global' }, language };
  const validRealm = context === 'global' || /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(realmId);
  const query = useQuery({ ...searchQueryOptions(selection),
    enabled: validRealm && initialPhrase.trim().length >= 2 });
  const results = query.data?.results ?? [];
  const filters = (group: string) => <><fieldset className="filter-group"><legend>Language</legend>
    {[[null, 'Any language'], ['en', 'English'], ['es', 'Spanish'], ['ja', 'Japanese']].map(([value, label]) =>
      <label className="filter-row" key={label}><input type="radio" name={group} checked={language === value}
        onChange={() => setLanguage(value)} />{label}</label>)}</fieldset>
    <p className="muted">Searches published contribution text in the selected language.</p></>;

  return <>
    <section className="search-intro" aria-labelledby="search-title">
      <div><h1 id="search-title" className="page-title">Search works</h1>
        <p className="search-phrase">{initialPhrase ? `“${initialPhrase}”` : 'Enter a search above'}</p></div>
      <div className="perspective-box">
        <label htmlFor="perspective">View results from a perspective</label>
        <select className="select-control" id="perspective" value={context}
          onChange={event => setContext(event.target.value as 'global' | 'realm')}>
          <option value="global">Global perspective</option><option value="realm">Realm perspective</option>
        </select>
        {context === 'realm' ? <label htmlFor="realm-id" className="realm-input-label">
          Realm ID<input id="realm-id" value={realmId} onChange={event => setRealmId(event.target.value)}
            placeholder="https://rezics.com/id/…" /></label> : null}
        <p>The perspective sets the context for how works are selected.</p>
      </div>
    </section>
    <div className="search-layout">
      <aside className="filter-rail" aria-label="Search filters">
        <div className="filter-desktop">{filters('language-desktop')}</div>
        <details className="filter-mobile"><summary>Filter results</summary>{filters('language-mobile')}</details>
      </aside>
      <div>
        {!validRealm ? <p className="state-panel">Enter a full Realm ID to search this perspective.</p> : null}
        <SearchResults total={query.data?.total} sequence={query.data?.sourcePosition.sequence}
          results={results} state={!validRealm ? 'blocked' : initialPhrase.trim().length < 2 ? 'idle'
            : query.isError ? 'error' : query.isSuccess ? 'ready' : 'loading'}
          error={query.error?.message} />
      </div>
    </div>
  </>;
}
