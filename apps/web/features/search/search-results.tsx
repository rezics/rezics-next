import type { search as EnglishSearch } from '../../i18n/en.ts';
import type { UiLocale } from '../../i18n/resources.ts';

export interface SearchResultRow {
  matchUnit: string;
  work: string;
  revision: string;
  language: string;
  reason?: string;
  title?: string;
}

export interface SearchResultsProps {
  locale: UiLocale;
  messages: typeof EnglishSearch;
  total?: number;
  sequence?: string;
  results?: readonly SearchResultRow[];
  state?: 'idle' | 'blocked' | 'loading' | 'error' | 'ready';
  error?: string;
}

function labelForWork(iri: string, messages: typeof EnglishSearch): string {
  const value = iri.split('/').at(-1) ?? iri;
  return `${messages.workPrefix}${value.slice(0, 8)}`;
}

export function SearchResults({ total, sequence, results = [], state = 'idle', error,
  locale, messages }: SearchResultsProps) {
  return <section aria-live="polite" aria-label={messages.resultsRegion}>
    <div className="results-head"><span>{total === undefined ? messages.results
      : `${messages.resultsPrefix}${new Intl.NumberFormat(locale).format(total)}${messages.resultsSuffix}`}</span>
      {sequence ? <span className="muted">{messages.sequencePrefix}{sequence}</span> : null}</div>
    {state === 'idle' ? <p className="state-panel">{messages.idle}</p> : null}
    {state === 'loading' ? <p className="state-panel">{messages.loading}</p> : null}
    {state === 'error' ? <p className="state-panel" role="alert">{messages.errorPrefix}{error ?? messages.retry}</p> : null}
    {state === 'ready' && results.length === 0 ? <p className="state-panel">{messages.empty}</p> : null}
    {state === 'ready' ? results.map(result => <article className="result-row" key={result.matchUnit}>
      <div><h2><a href={`/works/${encodeURIComponent(result.revision.split('/').at(-1) ?? '')}`}>
        {result.title ?? labelForWork(result.work, messages)}</a></h2>
        <p className="result-meta">{result.language} · {messages.mainVersion} · {messages.revision} {result.revision.split('/').at(-1)?.slice(0, 8)}</p>
        <p className="result-meta">{messages.workId} {result.work}</p></div>
      <div className="result-reason"><strong>{result.reason ? messages.realmRelation : messages.textMatch}</strong>
        <p>{result.reason ?? messages.defaultReason}</p></div>
    </article>) : null}
  </section>;
}
