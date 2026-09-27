import { buttonVariants } from '@rezics/ui/button';
import { cn } from '@rezics/ui/utils';
import { FilePenIcon, HistoryIcon, MessageSquareReplyIcon, type LucideIcon, SendIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import Link from '../shell/localized-link.tsx';
import type { UiLocale } from '../../i18n/define.ts';
import { EmptyState } from '../shell/empty-state.tsx';
import type { WorkPageMessages } from './messages.ts';
import { Region, RegionFailure } from './region.tsx';
import { type HistoryFilter, historyKinds, idOf, shortId, workHref } from './route.ts';
import type { HistoryKind, HistoryPage, Loaded } from './types.ts';

const kinds = {
  'metadata-revision': { icon: FilePenIcon, label: 'metadataRevised', filter: 'metadataActivity' },
  'publication-decision': { icon: SendIcon, label: 'versionPublished', filter: 'publicationActivity' },
  'reply-placement': { icon: MessageSquareReplyIcon, label: 'replyPlaced', filter: 'replyActivity' },
} as const satisfies Record<HistoryKind, { icon: LucideIcon; label: keyof WorkPageMessages;
  filter: keyof WorkPageMessages }>;

/**
 * The Work's public activity, newest first, as Main's history read gives it:
 * metadata revisions (each opens its exact revision), version publications and
 * replies placed in public Realms. Who acted and earlier text stay private.
 */
export function HistoryRegion({ history, workRef, kind, cursor, locale, messages }: {
  history: Loaded<HistoryPage>; workRef: string; kind: HistoryFilter | undefined; cursor: string | undefined;
  locale: UiLocale; messages: WorkPageMessages;
}) {
  const t = materializeData(messages, { locale });
  const firstPage = workHref(workRef, 'history', null, { kind });
  const filter = <nav aria-label={t.historyFilter} className="flex flex-wrap gap-1.5">
    {[undefined, ...historyKinds].map(option => <Link key={option ?? 'all'} href={workHref(workRef, 'history', null,
      { kind: option })} aria-current={option === kind ? 'true' : undefined}
      className={cn(buttonVariants({ size: 'sm', variant: option === kind ? 'soft' : 'ghost' }))}>
      {option ? t[kinds[option].filter] : t.allActivity}</Link>)}
  </nav>;
  if (!history.ok) {
    return <Region id="work-history" title={t.history}>
      {filter}
      <RegionFailure title={t.historyUnavailable} failure={history.failure} messages={messages} restartHref={firstPage} />
    </Region>;
  }
  const { items, nextCursor } = history.data;
  return <Region id="work-history" title={t.history}>
    <p className="text-muted-foreground text-sm">{t.historyOrder}</p>
    {filter}
    {items.length ? <ol className="grid divide-y divide-border/60 border-border/60 border-y">
      {items.map(item => {
        const { icon: Icon, label } = kinds[item.kind];
        const revision = item.kind === 'metadata-revision' ? idOf(item.id) : null;
        return <li key={item.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
              <Icon aria-hidden="true" className="size-4" /></span>
            <div className="grid min-w-0 gap-0.5">
              <p className="font-medium">{t[label]}</p>
              <p className="text-muted-foreground text-xs tabular-nums">
                {t.sequence({ sequence: item.sequence })} · <span className="font-mono">{shortId(item.id)}</span></p>
            </div>
          </div>
          {revision ? <Link href={`/works/${revision}`} className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
            {t.viewRevision}</Link> : null}
        </li>;
      })}
    </ol> : <EmptyState icon={HistoryIcon} headingLevel={3} title={kind ? t.noHistoryKind : t.noHistory} />}
    {cursor || nextCursor ? <nav aria-label={t.pagination} className="flex flex-wrap justify-between gap-2">
      {cursor ? <Link href={firstPage} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
        {t.firstPage}</Link> : <span />}
      {nextCursor ? <Link href={workHref(workRef, 'history', null, { kind, cursor: nextCursor })}
        className={buttonVariants({ variant: 'outline', size: 'sm' })}>{t.nextPage}</Link> : null}
    </nav> : null}
  </Region>;
}
