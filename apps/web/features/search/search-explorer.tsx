'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { SearchSelection, searchQueryOptions } from './query.ts';

function labelForWork(iri: string): string {
  const value = iri.split('/').at(-1) ?? iri;
  return `Work ${value.slice(0, 8)}`;
}

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
        <fieldset className="filter-group"><legend>Language</legend>
          {[[null, 'Any language'], ['en', 'English'], ['es', 'Spanish'], ['ja', 'Japanese']].map(([value, label]) =>
            <label className="filter-row" key={label}><input type="radio" name="language" checked={language === value}
              onChange={() => setLanguage(value)} />{label}</label>)}</fieldset>
        <p className="muted">Searches published contribution text in the selected language.</p>
      </aside>
      <section aria-live="polite" aria-label="Search results">
        <div className="results-head"><span>{query.data ? `Showing ${query.data.total} results` : 'Results'}</span>
          {query.data ? <span className="muted">Complete at sequence {query.data.sourcePosition.sequence}</span> : null}</div>
        {!initialPhrase || initialPhrase.trim().length < 2 ? <p className="state-panel">Enter at least two characters to search.</p> : null}
        {!validRealm ? <p className="state-panel">Enter a full Realm ID to search this perspective.</p> : null}
        {query.isPending && validRealm && initialPhrase.trim().length >= 2 ? <p className="state-panel">Searching…</p> : null}
        {query.isError ? <p className="state-panel" role="alert">Search is unavailable: {query.error.message}</p> : null}
        {query.isSuccess && results.length === 0 ? <p className="state-panel">No works matched this search.</p> : null}
        {query.isSuccess ? results.map(result => <article className="result-row" key={result.matchUnit}>
          <div><h2><a href={`/works/${encodeURIComponent(result.revision.split('/').at(-1) ?? '')}`}>
            {labelForWork(result.work)}</a></h2>
            <p className="result-meta">{result.language} · Main Version · Revision {result.revision.split('/').at(-1)?.slice(0, 8)}</p>
            <p className="result-meta">Work ID: {result.work}</p></div>
          <div className="result-reason"><strong>Text match</strong>
            <p>Matched the phrase in a published contribution.</p></div>
        </article>) : null}
      </section>
    </div>
  </>;
}
