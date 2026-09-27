'use client';

// Interactive parts of modules. Modules render on the server and hand these
// their already-rendered cards, so a Zone page is complete without script.

import { Button } from '@rezics/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@rezics/ui/tabs';
import { cn } from '@rezics/ui/utils';
import type { ZoneModule } from '@rezics/zone-sdk';
import { MegaphoneIcon, RefreshCwIcon, XIcon } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { ModuleFrame } from './module-frame.tsx';
import { ScrollRow } from './scroll-row.tsx';

/** Sections of one module (New chapters / Newly added / Completed) under its title. */
export function ModuleTabs({ tabs, label }: {
  tabs: readonly { id: string; label: string; content: ReactNode }[]; label: string;
}) {
  if (tabs.length === 1) return tabs[0]!.content;
  return <Tabs defaultValue={tabs[0]?.id} className="gap-3">
    <TabsList variant="underline" aria-label={label} className="-mt-1 max-w-full justify-start overflow-x-auto
      [scrollbar-width:none]">
      {tabs.map(tab => <TabsTrigger key={tab.id} value={tab.id} className="grow-0 px-3">{tab.label}</TabsTrigger>)}
    </TabsList>
    {tabs.map(tab => <TabsContent key={tab.id} value={tab.id}>{tab.content}</TabsContent>)}
  </Tabs>;
}

/**
 * A module whose "Shuffle" steps through its picks a window at a time, as
 * KadoKado's 换一换 does. Deterministic, so the server and browser agree.
 */
export function ShuffleModule({ module, items, size, more, shuffleLabel, previous, next, render }: {
  module: ZoneModule; items: readonly ReactNode[]; size: number; more: string; shuffleLabel: string;
  previous: string; next: string;
  /** Lays out the visible window: a swipeable row of covers, a grid of rows or a list. */
  render: 'row' | 'grid' | 'list';
}) {
  const [start, setStart] = useState(0);
  const pages = Math.ceil(items.length / size);
  const visible = items.slice(start * size, start * size + size);
  const layout = { grid: 'grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3',
    list: 'grid grid-cols-1 gap-2' };
  return <ModuleFrame module={module} more={more} actions={module.shuffle && pages > 1
    ? <Button variant="ghost" size="sm" className="text-primary" onClick={() => setStart((start + 1) % pages)}>
      {shuffleLabel}<RefreshCwIcon aria-hidden="true" /></Button> : null}>
    <div aria-live="polite">
      {render === 'row' ? <ScrollRow key={start} label={module.title} previous={previous} next={next}>{visible}</ScrollRow>
        : <ul className={layout[render]}>
          {visible.map((item, index) => <li key={start * size + index} className="min-w-0">{item}</li>)}
        </ul>}
    </div>
  </ModuleFrame>;
}

/** One announcement line the reader can dismiss for this visit. */
export function Announcement({ children, label, dismiss, className }: {
  children: ReactNode; label: string; dismiss: string; className?: string;
}) {
  const [open, setOpen] = useState(true);
  if (!open) return null;
  return <aside aria-label={label} className={cn('flex min-h-11 items-center gap-3 rounded-(--zone-radius-card)',
    'bg-(--zone-panel) px-3 text-sm ring-1 ring-border/60', className)}>
    <MegaphoneIcon aria-hidden="true" className="size-4 shrink-0 text-primary" />
    <div className="min-w-0 flex-1 truncate">{children}</div>
    <Button variant="ghost" size="icon-sm" aria-label={dismiss} onClick={() => setOpen(false)}>
      <XIcon aria-hidden="true" /></Button>
  </aside>;
}
