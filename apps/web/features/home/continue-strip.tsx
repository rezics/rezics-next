'use client';

import { Button } from '@rezics/ui/button';
import { cn } from '@rezics/ui/utils';
import { Undo2Icon, XIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import { useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { CatalogueCover } from '../catalogue/cover.tsx';
import { coverKindOf } from '../catalogue/work.ts';
import { commandKey } from '../feed/api.ts';
import { useFeed } from '../feed/feed-context.tsx';
import type { ContinueItem } from '../feed/types.ts';
import LocalizedLink from '../shell/localized-link.tsx';
import type { HomeMessages } from './messages.ts';

/**
 * Works the reader is in the middle of, and followed Works with chapters they
 * have not read, newest first: one tap opens the next unread chapter. It is
 * not a recommendation, so it sits above the feed and never inside it.
 */
export function ContinueStrip({ items, locale, messages }: { items: readonly ContinueItem[]; locale: UiLocale;
  messages: HomeMessages }) {
  const t = materializeData(messages, { locale });
  const { api, actingSubject, avatarQuery } = useFeed();
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [last, setLast] = useState<ContinueItem | null>(null);
  const [failed, setFailed] = useState(false);
  const shown = items.filter(item => !hidden.has(item.work));

  async function hide(item: ContinueItem, value: boolean) {
    if (!actingSubject) return;
    setFailed(false);
    setHidden(current => { const next = new Set(current); if (value) next.add(item.work); else next.delete(item.work); return next; });
    setLast(value ? item : null);
    const result = await api().hideContinue(item.work, value, actingSubject, commandKey());
    if (result.ok) return;
    setHidden(current => { const next = new Set(current); if (value) next.delete(item.work); else next.add(item.work); return next; });
    setLast(null);
    setFailed(true);
  }

  if (!shown.length && !last) return null;
  return <section aria-labelledby="continue-title" className="grid gap-3 px-3 sm:px-0">
    <h2 id="continue-title" className="font-semibold text-lg">{t.continueTitle}</h2>
    <ul className="-mx-3 flex snap-x snap-mandatory gap-4 overflow-x-auto px-3 pb-2 [scrollbar-width:thin] sm:mx-0
      sm:px-0">
      {shown.map(item => {
        const title = item.title.value;
        const unread = item.unreadCount.kind === 'exact' ? t.newChapters(item.unreadCount.value)
          : t.newChaptersAtLeast(item.unreadCount.value);
        return <li key={item.work} className="group/continue relative w-28 shrink-0 snap-start sm:w-32">
          <LocalizedLink href={item.nextUnread.href} aria-label={t.continueWork({ title })}
            className="grid gap-2 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <span className="relative">
              <CatalogueCover work={{ id: item.work, title: { ...item.title, value: title }, cover: item.cover,
                kind: coverKindOf(item.types), authors: [] }} avatarQuery={avatarQuery} size="fill" />
              <span className="absolute start-1.5 bottom-1.5 z-20 rounded-full bg-primary px-2 py-0.5 font-semibold
                text-[11px] text-primary-foreground shadow">{unread}</span>
            </span>
            <span lang={item.title.language} className="line-clamp-2 font-medium font-work-title text-sm/snug">{title}</span>
            <span lang={item.title.language} className="line-clamp-1 text-muted-foreground text-xs">
              {item.nextUnread.title ? t.nextChapter({ chapter: item.nextUnread.title }) : t.nextUp}</span>
          </LocalizedLink>
          {actingSubject ? <button type="button" aria-label={t.hideFromContinue({ title })}
            title={t.hideFromContinue({ title })} onClick={() => void hide(item, true)}
            className={cn('absolute end-1.5 top-1.5 z-30 grid size-7 place-items-center rounded-full bg-background/90',
              'text-foreground shadow outline-none backdrop-blur transition-opacity focus-visible:ring-2',
              'focus-visible:ring-ring pointer-fine:opacity-0 pointer-fine:group-hover/continue:opacity-100',
              'pointer-fine:focus-visible:opacity-100')}>
            <XIcon aria-hidden="true" className="size-4" /></button> : null}
        </li>;
      })}
    </ul>
    {last ? <p role="status" className="flex flex-wrap items-center gap-2 text-muted-foreground text-sm">
      {t.hiddenFromContinue({ title: last.title.value })}
      <Button variant="ghost" size="sm" onClick={() => void hide(last, false)}>
        <Undo2Icon aria-hidden="true" />{t.undo}</Button>
    </p> : null}
    {failed ? <p role="status" className="text-destructive-foreground text-sm">{t.hideFailed}</p> : null}
  </section>;
}
