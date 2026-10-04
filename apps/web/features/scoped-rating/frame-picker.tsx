'use client';

import { Button } from '@rezics/ui/button';
import { badgeVariants } from '@rezics/ui/badge';
import { EntityPicker } from '@rezics/ui/entity-picker';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@rezics/ui/tabs';
import { cn } from '@rezics/ui/utils';
import { XIcon } from 'lucide-react';
import type { UiLocale } from '../../i18n/define.ts';
import { frameDimensions, type FrameCandidate, type FrameDimension, MAX_FRAMES, withFrame, withoutFrame } from './frames.ts';
import { translate, type Translation } from './format.ts';
import type { ScopedRatingMessages } from './messages.ts';
import type { FrameOption, FrameSource } from './sources.ts';

function kindName(dimension: FrameDimension, t: Translation): string {
  switch (dimension) {
    case 'position': return t.dimensionPosition;
    case 'event': return t.dimensionEvent;
    case 'continuity': return t.dimensionContinuity;
    case 'work': return t.dimensionWork;
    case 'release': return t.dimensionRelease;
    case 'realization': return t.dimensionRealization;
  }
}

/**
 * Chooses where a rating applies. Only kinds of place that Main accepts as frames are offered: a source for anything
 * else cannot be listed, and choosing a second place of one kind replaces the first, as Main allows one of each.
 */
export function FramePicker({ sources, value, onChange, onContinue, busy = false, locale, messages }: {
  sources: readonly FrameSource[]; value: readonly FrameCandidate[]; onChange: (next: FrameCandidate[]) => void;
  onContinue: () => void; busy?: boolean; locale: UiLocale; messages: ScopedRatingMessages;
}) {
  const t = translate(messages, locale);
  const offered = sources.filter(source => frameDimensions.includes(source.dimension));
  const choose = (picked: { item: FrameOption }[]) => {
    const item = picked[0]?.item;
    if (item && frameDimensions.includes(item.candidate.dimension)) onChange(withFrame(value, item.candidate));
  };
  const picker = (source: FrameSource) => <EntityPicker<FrameOption> label={source.label ?? kindName(source.dimension, t)}
    placeholder={t.searchPlaces} locale={locale} load={source.load} value={[]} selectionBehavior="clear" onValueChange={choose}
    renderItem={item => <bdi lang={item.candidate.name.language || undefined} dir={item.candidate.name.direction}
      className="truncate">{item.label}</bdi>} />;
  return <div data-frame-picker className="grid gap-4">
    {offered.length === 1 ? picker(offered[0]!)
      : <Tabs defaultValue={offered[0]?.dimension} className="gap-3">
        <TabsList variant="underline" aria-label={t.places} className="-mt-1 max-w-full justify-start overflow-x-auto [scrollbar-width:none]">
          {offered.map(source => <TabsTrigger key={source.dimension} value={source.dimension} className="grow-0 px-3">
            {source.label ?? kindName(source.dimension, t)}</TabsTrigger>)}
        </TabsList>
        {offered.map(source => <TabsContent key={source.dimension} value={source.dimension}>{picker(source)}</TabsContent>)}
      </Tabs>}

    <div className="grid gap-2">
      <p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">{t.chosen}</p>
      {value.length === 0 ? <p className="text-muted-foreground text-sm">{t.nothingChosen}</p>
        : <ul className="flex flex-wrap gap-1.5">
          {value.map(frame => <li key={frame.iri} className="min-w-0 max-w-full">
            <span className={cn(badgeVariants({ variant: 'soft', size: 'lg' }), 'max-w-full pe-1')}>
              <bdi lang={frame.name.language || undefined} dir={frame.name.direction} className="truncate">{frame.name.value}</bdi>
              <button type="button" aria-label={t.removePlace({ name: frame.name.value })}
                onClick={() => onChange(withoutFrame(value, frame.iri))}
                className="grid size-5 place-items-center rounded-full outline-none hover:bg-primary/15 focus-visible:ring-2 focus-visible:ring-ring">
                <XIcon aria-hidden="true" className="size-3" /></button>
            </span>
          </li>)}
        </ul>}
    </div>
    <Button disabled={busy || value.length === 0 || value.length > MAX_FRAMES} isLoading={busy} onClick={onContinue}
      className="justify-self-start">{t.continue}</Button>
  </div>;
}
