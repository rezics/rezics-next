import { WorkCover } from '@rezics/ui/work-cover';
import { cn } from '@rezics/ui/utils';
import { Check } from 'lucide-react';
import type { IllustrationCopy } from '../i18n/messages/illustrations.ts';
import { fill } from '../i18n/messages/illustrations.ts';
import { localeNames, type UiLocale } from '../i18n/locales.ts';
import { Plate } from './Plate.tsx';
import { series } from './sample.ts';

type State = 'read' | 'owned' | 'next' | 'upcoming';

const editions = [
  {
    work: series.english,
    id: '5a1e0b7c-6d2f-4b83-a9c4-0e1f2a3b4c01',
    format: 'paperback',
    volumes: ['read', 'read', 'owned', 'next', 'upcoming'] as State[],
  },
  {
    work: series.chinese,
    id: '8c2d1e0f-7a3b-4c94-b0d5-1f2a3b4c5d02',
    format: 'translation',
    volumes: ['read', 'owned', 'upcoming'] as State[],
  },
] as const;

/** A series as a timeline per edition: what is read, owned, next and still to come. */
export function SeriesTimeline({ words }: { words: IllustrationCopy }) {
  const stateLabel: Record<State, string> = {
    read: words.read,
    owned: words.owned,
    next: words.next,
    upcoming: words.upcoming,
  };
  return (
    <Plate className="flex flex-col gap-6">
      {editions.map(({ work, id, format, volumes }) => (
        <div key={id}>
          <p className="mb-3 flex flex-wrap items-baseline gap-x-2 text-sm">
            <span lang={work.lang} className="font-work-title font-semibold">
              {work.title}
            </span>
            <span className="text-muted-foreground">
              {words[format]} · <span lang={work.lang}>{localeNames[work.lang as UiLocale]}</span>
            </span>
          </p>
          <ol className="flex gap-2 sm:gap-3">
            {volumes.map((state, index) => (
              <li key={index} className="flex w-1/5 max-w-24 flex-col items-center gap-1.5">
                <div
                  className={cn(
                    'relative w-full',
                    state === 'upcoming' && 'opacity-60',
                    state === 'next' &&
                      'rounded-md ring-2 ring-primary ring-offset-2 ring-offset-card',
                  )}
                >
                  <WorkCover
                    kind="book"
                    id={`${id}-${index}`}
                    title={fill(words.volume, index + 1)}
                    lang={work.lang}
                    className={cn(
                      'w-full rounded-md',
                      state === 'upcoming' && 'border border-dashed border-border',
                    )}
                  />
                  {state === 'read' && (
                    <span className="absolute -end-1 -top-1 flex size-5 items-center justify-center rounded-full bg-success-foreground text-background">
                      <Check aria-hidden className="size-3" />
                    </span>
                  )}
                </div>
                <span
                  className={cn(
                    'text-center text-xs',
                    state === 'next' ? 'font-semibold text-primary' : 'text-muted-foreground',
                  )}
                >
                  {stateLabel[state]}
                </span>
              </li>
            ))}
          </ol>
        </div>
      ))}
    </Plate>
  );
}
