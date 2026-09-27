import { Alert, AlertAction, AlertDescription, AlertTitle } from '@rezics/ui/alert';
import { Badge } from '@rezics/ui/badge';
import { Button } from '@rezics/ui/button';
import { Card } from '@rezics/ui/card';
import { Skeleton } from '@rezics/ui/skeleton';
import { CircleAlertIcon, RotateCwIcon, SearchIcon, SearchXIcon, TriangleAlertIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import type { UiLocale } from '../../i18n/define.ts';
import { EmptyState } from '../shell/empty-state.tsx';
import type { SearchMessages } from './messages.ts';

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
  messages: SearchMessages;
  total?: number;
  sequence?: string;
  results?: readonly SearchResultRow[];
  /** `blocked`: the selected perspective is incomplete, so no query runs. */
  state?: 'idle' | 'blocked' | 'loading' | 'error' | 'ready';
  error?: string;
  onRetry?: () => void;
}

const lastSegment = (iri: string) => iri.split('/').at(-1) ?? iri;

export function SearchResults({ total, sequence, results = [], state = 'idle', error, onRetry,
  locale, messages }: SearchResultsProps) {
  const t = materializeData(messages, { locale });
  return <section aria-live="polite" aria-label={t.resultsRegion} aria-busy={state === 'loading'}
    className="grid gap-4">
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-sm">
      <span className="font-medium">{total === undefined ? t.results : t.resultCount(total)}</span>
      {sequence ? <span className="text-muted-foreground">{t.sequence({ sequence })}</span> : null}
    </div>
    {state === 'idle' ? <EmptyState icon={SearchIcon} title={t.idleTitle} description={t.idle} /> : null}
    {state === 'blocked' ? <Alert variant="warning">
      <CircleAlertIcon aria-hidden="true" />
      <AlertDescription className="text-foreground">{t.invalidRealm}</AlertDescription>
    </Alert> : null}
    {state === 'loading' ? <div className="grid gap-4">
      <span className="sr-only">{t.loading}</span>
      {[0, 1, 2].map(row => <Card key={row} aria-hidden="true" className="gap-3 px-6">
        <Skeleton className="h-6 w-2/3 rounded-lg" />
        <div className="flex gap-2"><Skeleton className="h-6 w-20 rounded-full" /><Skeleton className="h-6 w-28 rounded-full" /></div>
        <Skeleton className="h-4 w-1/2 rounded-md" />
      </Card>)}
    </div> : null}
    {state === 'error' ? <Alert variant="destructive" role="alert">
      <TriangleAlertIcon aria-hidden="true" />
      <AlertTitle>{t.errorTitle}</AlertTitle>
      <AlertDescription>{error ?? t.errorFallback}</AlertDescription>
      {onRetry ? <AlertAction>
        <Button size="sm" variant="outline" onClick={onRetry}><RotateCwIcon aria-hidden="true" />{t.retry}</Button>
      </AlertAction> : null}
    </Alert> : null}
    {state === 'ready' && results.length === 0
      ? <EmptyState icon={SearchXIcon} title={t.empty} description={t.emptyHelp} /> : null}
    {state === 'ready' && results.length > 0 ? <ol className="grid gap-4">
      {results.map(result => {
        const revision = lastSegment(result.revision);
        return <li key={result.matchUnit}>
          <Card asChild className="relative gap-4 px-6 sm:flex-row sm:items-start sm:justify-between"><article>
            <div className="min-w-0 space-y-3">
              <h2 className="font-semibold font-work-title text-xl/snug">
                <a href={`/works/${encodeURIComponent(revision)}`} className="outline-none after:absolute
                  after:inset-0 after:rounded-2xl hover:text-primary focus-visible:after:ring-2 focus-visible:after:ring-ring">
                  {result.title ?? t.workFallback({ id: lastSegment(result.work).slice(0, 8) })}</a>
              </h2>
              <div className="flex flex-wrap gap-1.5">
                <Badge variant="soft">{result.language}</Badge>
                <Badge variant="outline">{t.mainVersion}</Badge>
                <Badge variant="outline" className="font-mono">{t.revision({ id: revision.slice(0, 8) })}</Badge>
              </div>
              <p className="break-all text-muted-foreground text-xs">
                {t.workId} <span className="font-mono">{result.work}</span></p>
            </div>
            <div className="rounded-xl bg-muted/70 p-3 text-sm sm:w-64 sm:shrink-0">
              <p className="font-medium">{result.reason ? t.realmRelation : t.textMatch}</p>
              <p className="mt-1 text-muted-foreground">{result.reason ?? t.defaultReason}</p>
            </div>
          </article></Card>
        </li>;
      })}
    </ol> : null}
  </section>;
}
