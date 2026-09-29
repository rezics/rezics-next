import { Badge } from '@rezics/ui/badge';
import { cn } from '@rezics/ui/utils';
import { BookOpen, Check, Lock } from 'lucide-react';
import { fill } from '../i18n/fill.ts';
import type { IllustrationCopy } from '../i18n/messages/illustrations.ts';
import { Plate } from './Plate.tsx';
import { world } from './sample.ts';

const cite = (words: IllustrationCopy, n: number) => (
  <sup className="ms-0.5 font-sans text-xs font-semibold text-primary">
    {fill(words.shelf.chapter, { n })}
  </sup>
);

/**
 * A character's page in a Work's wiki, read at chapter 9: prose with chapter citations,
 * an infobox built from the same sourced facts, and a family entry held back until the
 * chapter that reveals it.
 */
export function WikiArticle({ words, className }: { words: IllustrationCopy; className?: string }) {
  const w = words.wiki;
  return (
    <Plate className={cn('flex flex-col gap-5', className)}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Badge variant="soft" size="md">
          <BookOpen aria-hidden />
          {fill(w.safeThrough, { n: 9 })}
        </Badge>
        <Badge variant="success" size="md">
          <Check aria-hidden />
          {w.reviewed}
        </Badge>
      </div>
      <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_12rem]">
        <article>
          <h3 lang="en" className="font-work-title text-3xl font-semibold">
            {world.kaede}
          </h3>
          <p className="mt-3 font-work-title leading-relaxed">
            <span lang="en">
              Kaede arrives at the Lantern Archive on the last ferry of the year, carrying a letter
              of apprenticeship
            </span>
            {cite(words, 1)}
            <span lang="en">
              . The archive lights one lantern for every book on loan, and she is given the task of
              tending them
            </span>
            {cite(words, 4)}.
          </p>
          <p className="mt-3 font-work-title leading-relaxed">
            <span lang="en">
              Her teacher, the keeper Ren Tachibana, trusts her with the marsh ledgers after the
              flood
            </span>
            {cite(words, 9)}.
          </p>
        </article>
        <aside className="self-start rounded-2xl border border-border bg-background p-4 text-sm">
          <dl className="grid gap-3">
            <div>
              <dt className="text-muted-foreground">{w.firstAppears}</dt>
              <dd className="font-semibold">{fill(words.shelf.chapter, { n: 1 })}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{w.home}</dt>
              <dd lang="en" className="font-semibold">
                {world.archive}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{w.teacher}</dt>
              <dd className="font-semibold">
                <span lang="en">{world.ren}</span>
                {cite(words, 9)}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{w.family}</dt>
              <dd className="mt-1 flex items-center gap-1.5 text-primary">
                <Lock aria-hidden className="size-3.5" />
                {fill(w.hiddenUntil, { n: 12 })}
              </dd>
            </div>
          </dl>
        </aside>
      </div>
      <p className="border-t border-border pt-4 text-sm text-muted-foreground">
        <span className="font-semibold text-foreground">{w.sources}</span>{' '}
        <span lang="en" className="font-work-title italic">
          {world.archive}
        </span>
        , {w.sourceLine}
      </p>
    </Plate>
  );
}
