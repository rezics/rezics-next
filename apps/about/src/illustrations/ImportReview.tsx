import { buttonVariants } from '@rezics/ui/button';
import { WorkCover } from '@rezics/ui/work-cover';
import { cn } from '@rezics/ui/utils';
import { Check, CircleDashed, FileSpreadsheet, Info } from 'lucide-react';
import type { CSSProperties } from 'react';
import { fill } from '../i18n/fill.ts';
import type { IllustrationCopy } from '../i18n/messages/illustrations.ts';
import { Plate } from './Plate.tsx';
import { lantern, saltMarsh, shelf } from './sample.ts';

/**
 * A library import under review: one row matched to its edition, one waiting for the
 * reader to choose between two look-alike editions, one kept in the report, and the
 * list of what will not carry over, all before anything is applied.
 */
export function ImportReview({
  words,
  className,
}: {
  words: IllustrationCopy;
  className?: string;
}) {
  const w = words.importer;
  return (
    <Plate className={cn('flex flex-col gap-4', className)}>
      <p className="flex items-center gap-2 text-sm font-semibold">
        <FileSpreadsheet aria-hidden className="size-4 text-primary" />
        <span lang="en" translate="no">
          {w.file}
        </span>
      </p>
      <ul className="flex flex-col gap-3">
        <li
          data-arrive
          style={{ '--at': 0 } as CSSProperties}
          className="flex items-center gap-3 rounded-2xl border border-border bg-background p-3"
        >
          <WorkCover
            kind="book"
            id={lantern.id}
            title={lantern.editions[2].title}
            lang="en"
            authors={[lantern.author.en]}
            className="w-11 shrink-0 rounded-[3px]"
          />
          <div className="min-w-0 flex-1">
            <p lang="en" className="truncate font-work-title font-semibold">
              {lantern.editions[2].title}
            </p>
            <p className="mt-0.5 flex items-center gap-1.5 text-sm text-success-foreground">
              <Check aria-hidden className="size-4 shrink-0" />
              {fill(w.matched, { year: 2021 })}
            </p>
          </div>
        </li>
        <li
          data-arrive
          style={{ '--at': 8 } as CSSProperties}
          className="rounded-2xl border-2 border-primary/60 bg-background p-3"
        >
          <p lang="en" className="font-work-title font-semibold">
            {saltMarsh.en}
          </p>
          <p className="mt-0.5 text-sm text-muted-foreground">{w.choose}</p>
          <div className="mt-3 grid grid-cols-2 gap-2">
            {[2019, 2023].map((year, index) => (
              <div
                key={year}
                className={cn(
                  'flex items-center gap-2.5 rounded-xl border p-2',
                  index === 0 ? 'border-primary bg-accent' : 'border-border',
                )}
              >
                <WorkCover
                  kind="book"
                  id={`${saltMarsh.id}-${year}`}
                  title={saltMarsh.en}
                  lang="en"
                  authors={[saltMarsh.author]}
                  className="w-8 shrink-0 rounded-[2px]"
                />
                <span className="text-sm">
                  <span className="block font-semibold tabular-nums">{year}</span>
                  <span className="block text-muted-foreground">{words.shelf.paperback}</span>
                </span>
              </div>
            ))}
          </div>
        </li>
        <li
          data-arrive
          style={{ '--at': 16 } as CSSProperties}
          className="flex items-center gap-3 rounded-2xl border border-dashed border-border p-3"
        >
          <WorkCover
            kind="book"
            id={shelf[1].id}
            title={shelf[1].title}
            lang="en"
            authors={[shelf[1].author]}
            className="w-11 shrink-0 rounded-[3px] opacity-80"
          />
          <div className="min-w-0 flex-1">
            <p lang="en" className="truncate font-work-title font-semibold">
              {shelf[1].title}
            </p>
            <p className="mt-0.5 flex items-center gap-1.5 text-sm text-muted-foreground">
              <CircleDashed aria-hidden className="size-4 shrink-0" />
              {w.unmatched}
            </p>
          </div>
        </li>
      </ul>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
        <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Info aria-hidden className="size-4 shrink-0" />
          {w.notCarried}
        </p>
        <span className={buttonVariants({ size: 'sm' })}>{w.apply}</span>
      </div>
    </Plate>
  );
}
