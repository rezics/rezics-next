export interface SearchResultRow {
  matchUnit: string;
  work: string;
  revision: string;
  language: string;
  reason?: string;
  title?: string;
}

export interface SearchResultsProps {
  total?: number;
  sequence?: string;
  results?: readonly SearchResultRow[];
  state?: 'idle' | 'blocked' | 'loading' | 'error' | 'ready';
  error?: string;
}

function labelForWork(iri: string): string {
  const value = iri.split('/').at(-1) ?? iri;
  return `Work ${value.slice(0, 8)}`;
}

export function SearchResults({ total, sequence, results = [], state = 'idle', error }: SearchResultsProps) {
  return <section aria-live="polite" aria-label="Search results">
    <div className="results-head"><span>{total === undefined ? 'Results' : `Showing ${total} results`}</span>
      {sequence ? <span className="muted">Complete at sequence {sequence}</span> : null}</div>
    {state === 'idle' ? <p className="state-panel">Enter at least two characters to search.</p> : null}
    {state === 'loading' ? <p className="state-panel">Searching…</p> : null}
    {state === 'error' ? <p className="state-panel" role="alert">Search is unavailable: {error ?? 'try again shortly'}</p> : null}
    {state === 'ready' && results.length === 0 ? <p className="state-panel">No works matched this search.</p> : null}
    {state === 'ready' ? results.map(result => <article className="result-row" key={result.matchUnit}>
      <div><h2><a href={`/works/${encodeURIComponent(result.revision.split('/').at(-1) ?? '')}`}>
        {result.title ?? labelForWork(result.work)}</a></h2>
        <p className="result-meta">{result.language} · Main Version · Revision {result.revision.split('/').at(-1)?.slice(0, 8)}</p>
        <p className="result-meta">Work ID: {result.work}</p></div>
      <div className="result-reason"><strong>{result.reason ? 'Realm relation' : 'Text match'}</strong>
        <p>{result.reason ?? 'Matched the phrase in a published contribution.'}</p></div>
    </article>) : null}
  </section>;
}
