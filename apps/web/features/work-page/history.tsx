import { Badge } from '@rezics/ui/badge';
import { buttonVariants } from '@rezics/ui/button';
import { HistoryIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import Link from 'next/link';
import type { UiLocale } from '../../i18n/define.ts';
import { EmptyState } from '../shell/empty-state.tsx';
import type { WorkPageMessages } from './messages.ts';
import { Region, RegionFailure } from './region.tsx';
import { idOf, shortId, workHref } from './route.ts';
import type { HistoryPage, Loaded } from './types.ts';

/**
 * The Work's metadata revisions, each linking to its exact read. Main lists
 * them by revision ID with their sequence; the page shows that order as it is
 * and says so, rather than sorting one page into a false chronology.
 */
export function HistoryRegion({ history, workRef, cursor, locale, messages }: {
  history: Loaded<HistoryPage>; workRef: string; cursor: string | undefined; locale: UiLocale;
  messages: WorkPageMessages;
}) {
  const t = materializeData(messages, { locale });
  const firstPage = workHref(workRef, 'history');
  if (!history.ok) {
    return <Region id="work-history" title={t.history}>
      <RegionFailure title={t.historyUnavailable} failure={history.failure} messages={messages} restartHref={firstPage} />
    </Region>;
  }
  const { items, nextCursor } = history.data;
  return <Region id="work-history" title={t.history}>
    <p className="text-muted-foreground text-sm">{t.historyOrder}</p>
    {items.length ? <ol className="grid divide-y divide-border/60 border-border/60 border-y">
      {items.map(item => {
        const revision = idOf(item.revision);
        return <li key={item.revision} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
          <div className="grid gap-0.5">
            <p className="flex flex-wrap items-center gap-2 font-medium">
              <span>{t.revision} <span className="font-mono">{shortId(item.revision)}</span></span>
              {item.current ? <Badge variant="soft">{t.current}</Badge> : null}
            </p>
            <p className="text-muted-foreground text-xs tabular-nums">{t.sequence({ sequence: item.sequence })}</p>
          </div>
          {revision ? <Link href={`/works/${revision}`} className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
            {t.viewRevision}</Link> : null}
        </li>;
      })}
    </ol> : <EmptyState icon={HistoryIcon} headingLevel={3} title={t.noHistory} />}
    {cursor || nextCursor ? <nav aria-label={t.pagination} className="flex flex-wrap justify-between gap-2">
      {cursor ? <Link href={firstPage} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
        {t.firstPage}</Link> : <span />}
      {nextCursor ? <Link href={workHref(workRef, 'history', null, { cursor: nextCursor })}
        className={buttonVariants({ variant: 'outline', size: 'sm' })}>{t.nextPage}</Link> : null}
    </nav> : null}
  </Region>;
}
