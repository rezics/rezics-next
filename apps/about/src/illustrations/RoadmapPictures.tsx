import { Badge } from '@rezics/ui/badge';
import { cn } from '@rezics/ui/utils';
import type { CSSProperties } from 'react';
import { fill } from '../i18n/fill.ts';
import { row } from './parts.tsx';
import { Plate } from './Plate.tsx';

const at = (percent: number) => ({ '--at': percent }) as CSSProperties;

/** One of GOAL.md's stages as the picture needs it: its name and the words for where it stands. */
export interface RouteStage {
  name: string;
  /** "In development", "Up next" or "Later", in the reader's language. */
  standing: string;
  /** True for the stage being built now, the one the ribbon marks. */
  now: boolean;
}

/**
 * The route to launch: five stops in order, the first filled and marked by the ribbon
 * because it is the stage being built. The stops arrive one after another as it scrolls in.
 */
export function RoadmapRoute({ stages }: { stages: readonly RouteStage[] }) {
  return (
    <Plate>
      <ol className="relative flex flex-col gap-3">
        <span
          aria-hidden
          className="absolute inset-y-4 start-[0.6875rem] w-0.5 rounded-full bg-border"
        />
        {stages.map((stage, index) => (
          <li
            key={stage.name}
            data-arrive
            style={at(index * 6)}
            className={cn(
              'relative flex items-center gap-4 rounded-xl border px-3 py-3',
              stage.now ? 'border-primary bg-accent' : 'border-border bg-background',
            )}
          >
            <span
              aria-hidden
              className={cn(
                'relative z-10 size-3.5 shrink-0 rounded-full border-2',
                stage.now ? 'border-primary bg-primary' : 'border-muted-foreground bg-background',
              )}
            />
            <span className="min-w-0 flex-1 font-semibold">{stage.name}</span>
            {stage.now ? (
              <span aria-hidden className="ribbon -mt-7 h-8 w-2.5 shrink-0 self-start" />
            ) : null}
            <span className="shrink-0 text-sm text-muted-foreground">{stage.standing}</span>
          </li>
        ))}
      </ol>
    </Plate>
  );
}

/**
 * One stage in the pinned story: where it sits among the five (filled segments up to it,
 * the ribbon on it), and a few of the capabilities it delivers, with how many more follow.
 */
export function StageFrame({
  stages,
  index,
  items,
  more,
  words,
}: {
  stages: readonly RouteStage[];
  index: number;
  items: readonly string[];
  more: number;
  words: { stageOf: string; more: string };
}) {
  const stage = stages[index]!;
  return (
    <Plate className="flex flex-col gap-5">
      <div>
        <ol aria-hidden className="flex gap-1.5">
          {stages.map((other, position) => (
            <li
              key={other.name}
              className={cn(
                'relative h-1.5 flex-1 rounded-full',
                position <= index ? 'bg-primary' : 'bg-secondary',
              )}
            >
              {position === index ? (
                <span className="ribbon absolute -top-2 end-1 h-5 w-2" />
              ) : null}
            </li>
          ))}
        </ol>
        <p className="mt-4 flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-semibold text-muted-foreground">
            {fill(words.stageOf, { n: index + 1, total: stages.length })}
          </span>
          <Badge variant={stage.now ? 'info' : 'outline'} size="md">
            {stage.standing}
          </Badge>
        </p>
      </div>
      <ul className="flex flex-col gap-2">
        {items.map((item, position) => (
          <li key={item} data-arrive style={at(position * 5)} className={row}>
            {item}
          </li>
        ))}
        {more > 0 ? (
          <li className="px-1 text-sm text-muted-foreground">{fill(words.more, { n: more })}</li>
        ) : null}
      </ul>
    </Plate>
  );
}
