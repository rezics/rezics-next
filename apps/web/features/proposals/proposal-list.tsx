'use client';

import { Button } from '@rezics/ui/button';
import { cn } from '@rezics/ui/utils';
import { ChevronRightIcon, FilePenLineIcon, InboxIcon, TriangleAlertIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import { useMemo, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { EmptyState } from '../shell/empty-state.tsx';
import LocalizedLink from '../shell/localized-link.tsx';
import { bffListApi, type ListApi } from './commands.ts';
import { kindLabel } from './labels.ts';
import type { ProposalMessages } from './messages.ts';
import type { Loaded, ProposalPage, ProposalSummary, TargetName } from './types.ts';

export type ListView = 'mine' | 'review-requested';
export const listViews: readonly ListView[] = ['mine', 'review-requested'];

/** `?view=` back to a view; anything else is the viewer's own proposals. */
export const parseListView = (value: string | undefined): ListView => value === 'review-requested' ? value : 'mine';
export const listHref = (view: ListView) => view === 'mine' ? '/proposals' : `/proposals?view=${view}`;

/**
 * The viewer's proposals, or those waiting for their review, newest first as
 * Main lists them. Each row names what it is about and opens the proposal.
 */
export function ProposalList({ view, initial, names: initialNames, actingSubject, locale, messages, api: givenApi }: {
  view: ListView; initial: Loaded<ProposalPage>; names: Record<string, TargetName>; actingSubject: string;
  locale: UiLocale; messages: ProposalMessages; api?: ListApi;
}) {
  const t = materializeData(messages, { locale });
  const api = useMemo(() => givenApi ?? bffListApi(actingSubject, locale), [givenApi, actingSubject, locale]);
  const [items, setItems] = useState<ProposalSummary[]>(initial.ok ? initial.data.items : []);
  const [cursor, setCursor] = useState(initial.ok ? initial.data.nextCursor : null);
  const [names, setNames] = useState(initialNames);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(!initial.ok);
  const more = async () => {
    if (!cursor) return;
    setLoading(true);
    const page = await api.page(view, cursor);
    if (page.ok) {
      const found = await api.names(page.data.items.map(item => item.target.resource));
      setNames(known => ({ ...known, ...found }));
      setItems(known => [...known, ...page.data.items]);
      setCursor(page.data.nextCursor);
      setFailed(false);
    } else setFailed(true);
    setLoading(false);
  };
  const tabs = <nav aria-label={t.viewsLabel} className="flex gap-1 rounded-xl bg-muted p-1 text-sm">
    {listViews.map(item => <LocalizedLink key={item} href={listHref(item)} aria-current={item === view ? 'page' : undefined}
      className={cn('rounded-lg px-3 py-1.5 font-medium', item === view ? 'bg-background shadow-xs' : 'text-muted-foreground hover:text-foreground')}>
      {item === 'mine' ? t.viewMine : t.viewReview}</LocalizedLink>)}
  </nav>;
  if (failed && !items.length) return <div className="grid gap-5">{tabs}
    <EmptyState icon={TriangleAlertIcon} tone="destructive" role="alert" title={t.unavailableTitle} description={t.unavailableHelp}>
      <LocalizedLink href={listHref(view)} className="font-medium text-primary hover:underline">{t.retry}</LocalizedLink>
    </EmptyState></div>;
  if (!items.length) return <div className="grid gap-5">{tabs}
    <EmptyState icon={view === 'mine' ? FilePenLineIcon : InboxIcon}
      title={view === 'mine' ? t.emptyMineTitle : t.emptyReviewTitle}
      description={view === 'mine' ? t.emptyMineHelp : t.emptyReviewHelp} /></div>;
  return <div className="grid gap-5">{tabs}
    <ul aria-label={t.listLabel} className="grid gap-2">
      {items.map(item => {
        const name = names[item.target.resource];
        return <li key={item.id}>
          <LocalizedLink href={`/proposals/${item.id}`}
            className="flex items-center justify-between gap-3 rounded-2xl border border-border/60 bg-card px-4 py-3 hover:bg-accent">
            <span className="grid min-w-0 gap-0.5">
              <span className="truncate font-medium" {...name ? { lang: name.language, dir: name.direction } : {}}>
                {name?.value ?? t.unknownTarget}</span>
              <span className="text-muted-foreground text-xs">{kindLabel(item.kind, t as unknown as Record<string, unknown>)}</span>
            </span>
            <ChevronRightIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground rtl:rotate-180" />
          </LocalizedLink>
        </li>;
      })}
    </ul>
    {failed ? <p role="alert" className="text-destructive-foreground text-sm">{t.unavailableHelp}</p> : null}
    {cursor ? <Button variant="outline" className="w-fit" disabled={loading} onClick={() => void more()}>
      {loading ? t.loadingMore : t.loadMore}</Button> : null}
  </div>;
}
