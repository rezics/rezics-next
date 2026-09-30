import { Button, buttonVariants } from '@rezics/ui/button';
import { Popover, PopoverContent, PopoverHeader, PopoverTrigger } from '@rezics/ui/popover';
import { cn } from '@rezics/ui/utils';
import { CircleHelpIcon, FilePenIcon, HistoryIcon, MessageSquareReplyIcon, type LucideIcon, SendIcon }
  from 'lucide-react';
import { materializeData } from 'native-i18n';
import Link from '../shell/localized-link.tsx';
import type { UiLocale } from '../../i18n/define.ts';
import { EmptyState } from '../shell/empty-state.tsx';
import type { WorkPageMessages } from './messages.ts';
import { Region, RegionFailure } from './region.tsx';
import { formatDate, mintedAt } from './format.ts';
import { type HistoryFilter, historyKinds, idOf, type WorkAt, workHref } from './route.ts';
import type { HistoryKind, HistoryPage, Loaded } from './types.ts';

const kinds = {
  'metadata-revision': { icon: FilePenIcon, label: 'metadataRevised', filter: 'metadataActivity' },
  'publication-decision': { icon: SendIcon, label: 'versionPublished', filter: 'publicationActivity' },
  'reply-placement': { icon: MessageSquareReplyIcon, label: 'replyPlaced', filter: 'replyActivity' },
} as const satisfies Record<HistoryKind, { icon: LucideIcon; label: keyof WorkPageMessages;
  filter: keyof WorkPageMessages }>;

/** What History leaves out, behind a help button beside the order note, so the list itself reads plainly. */
function HistoryHelp({ label, text }: { label: string; text: string }) {
  return <Popover>
    <PopoverTrigger asChild>
      <Button type="button" variant="ghost" size="icon-sm" aria-label={label} className="text-muted-foreground">
        <CircleHelpIcon aria-hidden="true" /></Button>
    </PopoverTrigger>
    <PopoverContent className="w-72"><PopoverHeader title={label} description={text} /></PopoverContent>
  </Popover>;
}

/**
 * The Work's public activity, newest first, as Main's history read gives it:
 * metadata revisions (each opens its exact revision), version publications and
 * replies placed in public Realms. Who acted and earlier text stay private,
 * which a help tip says.
 */
export function HistoryRegion({ history, workRef, kind, cursor, locale, messages }: {
  history: Loaded<HistoryPage>; workRef: WorkAt; kind: HistoryFilter | undefined; cursor: string | undefined;
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
    <p className="flex items-center gap-1 text-muted-foreground text-sm">{t.historyOrder}
      <HistoryHelp label={t.aboutHistory} text={t.historyPrivacy} /></p>
    {filter}
    {items.length ? <ol className="grid divide-y divide-border/60 border-border/60 border-y">
      {items.map(item => {
        const { icon: Icon, label } = kinds[item.kind];
        const revision = item.kind === 'metadata-revision' ? idOf(item.id) : null;
        // Each entry's ID was minted when it happened.
        const when = mintedAt(item.id);
        return <li key={item.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
              <Icon aria-hidden="true" className="size-4" /></span>
            <div className="grid min-w-0 gap-0.5">
              <p className="font-medium">{t[label]}</p>
              {when ? <time dateTime={when.toISOString()} className="text-muted-foreground text-xs tabular-nums">
                {formatDate(when, locale)}</time> : null}
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
