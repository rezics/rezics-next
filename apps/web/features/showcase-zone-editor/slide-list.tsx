'use client';

import { Badge } from '@rezics/ui/badge';
import { Button } from '@rezics/ui/button';
import { cn } from '@rezics/ui/utils';
import { WorkCover } from '@rezics/ui/work-cover';
import { type ZoneWork, workCoverProps } from '@rezics/zone-sdk';
import { ArrowDownIcon, ArrowUpIcon, CalendarClockIcon, GripVerticalIcon, LinkIcon, Trash2Icon } from 'lucide-react';
import { useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import type { ArtSource } from './art.ts';
import type { ZoneEditorCopy } from './messages.ts';
import { scheduleState, type SlideDraft, slideProblems } from './slides.ts';

/** What the list calls a slide: its own title in the editor's language, else its default, else its Work or link. */
export function slideName(slide: SlideDraft, work: ZoneWork | null | undefined, locale: UiLocale, t: ZoneEditorCopy) {
  const own = slide.titles[locale]?.trim() || slide.title.trim();
  if (own) return own;
  if (slide.target.kind === 'work') return work?.title?.value || t.untitledSlide;
  return slide.target.href.trim() || t.untitledSlide;
}

function scheduleText(slide: SlideDraft, now: number, locale: UiLocale, t: ZoneEditorCopy) {
  const state = scheduleState(slide, now);
  const time = (iso: string) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
  if (state === 'always') return null;
  if (state === 'upcoming') return t.scheduleUpcoming({ time: time(slide.startsAt!) });
  if (state === 'ended') return t.scheduleEnded({ time: time(slide.endsAt!) });
  return slide.endsAt ? t.scheduleLiveUntil({ time: time(slide.endsAt) }) : t.scheduleLiveSince({ time: time(slide.startsAt!) });
}

/** A chip wraps its words instead of widening the row on a narrow screen. */
const chip = 'h-auto min-h-5 max-w-full whitespace-normal py-0.5 text-start';

const sourceText = (source: ArtSource, t: ZoneEditorCopy) => ({ campaign: t.artOwn, work: t.artWork, cover: t.artCover, none: t.artNone })[source];

/**
 * The slides in the order readers see them. A slide moves by dragging it or with its own move
 * buttons, which work from the keyboard; each slide shows where it leads, its schedule and which
 * art it uses.
 */
export function SlideList({ slides, selected, works, loading, now, locale, sources, onSelect, onMove, onDrop, onRemove, t }: {
  slides: readonly SlideDraft[]; selected: string | null; works: Readonly<Record<string, ZoneWork | null | undefined>>;
  loading: ReadonlySet<string>; now: number; locale: UiLocale; sources: Readonly<Record<string, ArtSource>>;
  onSelect: (key: string) => void; onMove: (key: string, offset: -1 | 1) => void; onDrop: (key: string, target: string) => void;
  onRemove: (key: string) => void; t: ZoneEditorCopy;
}) {
  const [dragging, setDragging] = useState<string | null>(null);
  return <ol aria-label={t.listLabel} className="grid gap-2">
    {slides.map((slide, index) => {
      const work = slide.target.kind === 'work' ? works[slide.target.work] : null;
      const name = slideName(slide, work, locale, t);
      const text = scheduleText(slide, now, locale, t);
      const unavailable = slide.target.kind === 'work' && Boolean(slide.target.work) && !work && !loading.has(slide.target.work);
      const invalid = slideProblems(slide).length > 0;
      const current = selected === slide.key;
      return <li key={slide.key} draggable={slides.length > 1} data-dragging={dragging === slide.key || undefined}
        onDragStart={event => { event.dataTransfer.setData('text/plain', slide.key); event.dataTransfer.effectAllowed = 'move'; setDragging(slide.key); }}
        onDragEnd={() => setDragging(null)}
        onDragOver={event => { if (dragging && dragging !== slide.key) event.preventDefault(); }}
        onDrop={event => { event.preventDefault(); if (dragging && dragging !== slide.key) onDrop(dragging, slide.key); setDragging(null); }}
        className={cn('flex flex-wrap items-stretch gap-1 rounded-2xl border bg-card p-1.5 data-dragging:opacity-50', current ? 'border-primary ring-1 ring-primary/40' : 'border-border/70')}>
        <span aria-hidden="true" title={t.dragSlide({ slide: name })} className={cn('hidden items-center px-1 text-muted-foreground sm:flex', slides.length > 1 && 'cursor-grab')}>
          <GripVerticalIcon className="size-4" /></span>
        <button type="button" onClick={() => onSelect(slide.key)} aria-current={current ? 'true' : undefined} aria-label={t.editSlide({ slide: name })}
          className="flex min-w-0 flex-[1_1_15rem] items-center gap-3 rounded-xl p-1.5 text-start outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring">
          <span className="w-5 shrink-0 text-center font-semibold text-muted-foreground tabular-nums">{index + 1}</span>
          <span className="relative block aspect-[3/4] w-9 shrink-0 overflow-hidden rounded-md bg-muted">
            {work ? <WorkCover size="fill" {...workCoverProps(work)} /> : <span className="grid size-full place-content-center text-muted-foreground"><LinkIcon className="size-4" aria-hidden="true" /></span>}
          </span>
          <span className="grid min-w-0 gap-1">
            <span className="truncate font-medium" lang={slide.title.trim() ? undefined : work?.title?.lang}>{name}</span>
            <span className="flex flex-wrap items-center gap-1.5">
              {index === 0 ? <Badge variant="info" size="sm" className={chip}>{t.firstSlide}</Badge> : null}
              {sources[slide.key] ? <Badge variant="outline" size="sm" className={chip}>{sourceText(sources[slide.key]!, t)}</Badge> : null}
              {text ? <Badge variant="outline" size="sm" className={chip}><CalendarClockIcon aria-hidden="true" />{text}</Badge> : null}
              {unavailable ? <Badge variant="destructive" size="sm" className={chip}>{t.workUnavailable}</Badge> : null}
              {invalid ? <Badge variant="warning" size="sm" className={chip}>{t.slideNeedsAttention}</Badge> : null}
            </span>
          </span>
        </button>
        <span className="ms-auto flex shrink-0 items-center">
          <Button type="button" variant="ghost" size="icon-sm" disabled={index === 0} aria-label={t.moveUp({ slide: name })} onClick={() => onMove(slide.key, -1)}>
            <ArrowUpIcon aria-hidden="true" /></Button>
          <Button type="button" variant="ghost" size="icon-sm" disabled={index === slides.length - 1} aria-label={t.moveDown({ slide: name })} onClick={() => onMove(slide.key, 1)}>
            <ArrowDownIcon aria-hidden="true" /></Button>
          <Button type="button" variant="ghost" size="icon-sm" aria-label={t.removeSlide({ slide: name })} onClick={() => onRemove(slide.key)}>
            <Trash2Icon aria-hidden="true" /></Button>
        </span>
      </li>;
    })}
  </ol>;
}
