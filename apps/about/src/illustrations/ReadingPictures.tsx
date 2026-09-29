import { Badge } from '@rezics/ui/badge';
import { buttonVariants } from '@rezics/ui/button';
import { WorkCover } from '@rezics/ui/work-cover';
import { cn } from '@rezics/ui/utils';
import {
  BookOpen,
  Check,
  CircleDashed,
  FileSpreadsheet,
  Headphones,
  Info,
  Library,
  Lock,
  Tablet,
} from 'lucide-react';
import type { CSSProperties } from 'react';
import { fill } from '../i18n/fill.ts';
import { row, type Picture, type Words } from './parts.ts';
import { Plate } from './Plate.tsx';
import { lantern, saltMarsh, shelf } from './sample.ts';

const at = (percent: number) => ({ '--at': percent }) as CSSProperties;

/** Progress in one edition: a thin bar with the reader's place marked by the ribbon. */
function Bar({ percent }: { percent: number }) {
  return (
    <div className="relative h-1.5 flex-1 rounded-full bg-secondary">
      <div className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
      <span
        className="ribbon absolute -top-2 h-5 w-2"
        style={{ insetInlineStart: `calc(${percent}% - 0.25rem)` }}
      />
    </div>
  );
}

/**
 * One story, four copies: the paperback on the shelf, the ebook already finished, the
 * audiobook half-way and a library loan due back, all counted as one read.
 */
export function LibraryHero({ words }: Words) {
  const s = words.shelf;
  const copies = [
    { icon: BookOpen, name: s.paperback, state: s.owned, done: false },
    { icon: Tablet, name: s.ebook, state: s.read, done: true },
    {
      icon: Headphones,
      name: s.audiobook,
      state: fill(words.library.minute, { n: 41 }),
      percent: 41,
    },
    {
      icon: Library,
      name: s.borrowed,
      state: fill(s.dueBack, { day: words.release.friday }),
      done: false,
    },
  ] as const;
  return (
    <Plate className="flex flex-col gap-5">
      <div className="flex items-center gap-4">
        <WorkCover
          kind="book"
          id={lantern.id}
          title={lantern.editions[2].title}
          lang="en"
          authors={[lantern.author.en]}
          className="w-20 shrink-0 rounded-[4px]"
        />
        <div className="min-w-0">
          <p lang="en" className="font-work-title text-xl font-semibold">
            {lantern.editions[2].title}
          </p>
          <Badge variant="soft" size="md" className="mt-1.5">
            <Check aria-hidden />
            {words.library.counted}
          </Badge>
        </div>
      </div>
      <ul className="flex flex-col gap-2.5">
        {copies.map((copy, index) => (
          <li
            key={copy.name}
            data-arrive
            style={at(index * 6)}
            className={cn(
              'flex flex-col gap-2.5 rounded-2xl border bg-background p-3.5',
              'percent' in copy ? 'border-primary' : 'border-border',
            )}
          >
            <p className="flex items-center gap-3">
              <copy.icon aria-hidden className="size-5 shrink-0 text-primary" />
              <span className="font-semibold">{copy.name}</span>
              <span className="ms-auto flex items-center gap-1.5 text-sm text-muted-foreground">
                {'done' in copy && copy.done ? (
                  <Check aria-hidden className="size-4 text-success-foreground" />
                ) : null}
                {copy.state}
              </span>
            </p>
            {'percent' in copy ? <Bar percent={copy.percent} /> : null}
          </li>
        ))}
      </ul>
    </Plate>
  );
}

/* ---------- The import, one step at a time ---------- */

function Matched({ words }: Words) {
  return (
    <li
      data-arrive
      style={at(0)}
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
          {fill(words.importer.matched, { year: 2021 })}
        </p>
      </div>
    </li>
  );
}

function Choose({ words }: Words) {
  return (
    <li
      data-arrive
      style={at(8)}
      className="rounded-2xl border-2 border-primary/60 bg-background p-3"
    >
      <p lang="en" className="font-work-title font-semibold">
        {saltMarsh.en}
      </p>
      <p className="mt-0.5 text-sm text-muted-foreground">{words.importer.choose}</p>
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
  );
}

function Unmatched({ words }: Words) {
  return (
    <li
      data-arrive
      style={at(16)}
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
          {words.importer.unmatched}
        </p>
      </div>
    </li>
  );
}

function Upload({ words }: Words) {
  return (
    <>
      <div
        data-arrive
        className="flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-primary/50 bg-background px-4 py-9 text-center"
      >
        <FileSpreadsheet aria-hidden className="size-9 text-primary" />
        <p lang="en" translate="no" className="font-mono text-sm font-semibold">
          {words.importer.file}
        </p>
        <p className="text-sm text-muted-foreground">{words.library.sources}</p>
      </div>
      <Badge variant="outline" size="md" className="self-start">
        <Lock aria-hidden />
        {words.library.nothingApplied}
      </Badge>
    </>
  );
}

function Resume({ words }: Words) {
  const reads = [
    {
      title: lantern.editions[2].title,
      lang: 'en',
      id: lantern.id,
      place: fill(words.library.page, { n: 212, total: 340 }),
      percent: 62,
    },
    {
      title: lantern.editions[1].title,
      lang: 'zh-Hant',
      id: lantern.id,
      place: '38%',
      percent: 38,
    },
    {
      title: shelf[2].title,
      lang: 'ja',
      id: shelf[2].id,
      place: fill(words.library.minute, { n: 41 }),
      percent: 21,
    },
  ] as const;
  return (
    <>
      <p className="text-sm font-semibold text-muted-foreground">{words.library.nowReading}</p>
      <ul className="flex flex-col gap-2.5">
        {reads.map((read, index) => (
          <li
            key={read.title}
            data-arrive
            style={at(index * 7)}
            className="flex items-center gap-3 rounded-2xl border border-border bg-background p-3"
          >
            <WorkCover
              kind="book"
              id={read.id}
              title={read.title}
              lang={read.lang}
              className="w-10 shrink-0 rounded-[3px]"
            />
            <div className="min-w-0 flex-1">
              <p className="flex items-baseline justify-between gap-2">
                <span lang={read.lang} className="truncate font-work-title font-semibold">
                  {read.title}
                </span>
                <span className="shrink-0 text-sm text-muted-foreground">{read.place}</span>
              </p>
              <div className="mt-2.5">
                <Bar percent={read.percent} />
              </div>
            </div>
          </li>
        ))}
      </ul>
      <p className="flex flex-wrap gap-2">
        <Badge variant="outline" size="md">
          {words.library.reread}
        </Badge>
        <Badge variant="outline" size="md">
          {words.library.setAside}
        </Badge>
      </p>
    </>
  );
}

export type ImportStage = 'upload' | 'match' | 'preview' | 'resume';

/** The import as it moves: the export dropped in, rows matched, the preview, then reads arriving with their place. */
export function ImportFlow({ words, stage }: Words & { stage: ImportStage }) {
  return (
    <Plate className="flex flex-col gap-4">
      {stage === 'upload' ? <Upload words={words} /> : null}
      {stage === 'match' ? (
        <ul className="flex flex-col gap-3">
          <Matched words={words} />
          <Choose words={words} />
        </ul>
      ) : null}
      {stage === 'preview' ? (
        <>
          <ul className="flex flex-col gap-3">
            <Unmatched words={words} />
          </ul>
          <div
            data-arrive
            style={at(10)}
            className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-background p-3.5"
          >
            <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <Info aria-hidden className="size-4 shrink-0" />
              {words.importer.notCarried}
            </p>
            <span className={buttonVariants({ size: 'sm' })}>{words.importer.apply}</span>
          </div>
        </>
      ) : null}
      {stage === 'resume' ? <Resume words={words} /> : null}
    </Plate>
  );
}

/* ---------- Showcase vignettes ---------- */

function Formats({ words }: Words) {
  const s = words.shelf;
  return (
    <div className="flex w-full max-w-md items-center gap-5">
      <WorkCover
        kind="book"
        id={lantern.id}
        title={lantern.editions[2].title}
        lang="en"
        authors={[lantern.author.en]}
        className="w-24 shrink-0 rounded-[4px]"
      />
      <span
        aria-hidden
        className="h-24 w-4 shrink-0 rounded-s-2xl border-y border-s border-current opacity-60"
      />
      <ul className="flex min-w-0 flex-1 flex-col gap-2">
        {[
          { icon: BookOpen, name: s.paperback },
          { icon: Tablet, name: s.ebook },
          { icon: Headphones, name: s.audiobook },
        ].map(({ icon: Icon, name }) => (
          <li key={name} className={row}>
            <span className="flex items-center gap-2">
              <Icon aria-hidden className="size-4 text-primary" />
              {name}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Rereads({ words }: Words) {
  const l = words.library;
  const reads = [
    { name: l.firstRead, year: 2023, done: true },
    { name: l.reread, year: 2025, done: true },
    { name: l.setAside, year: 2026, done: false },
  ] as const;
  return (
    <ul className="flex w-full max-w-xs flex-col gap-2">
      {reads.map((read) => (
        <li key={read.year} className={row}>
          <span className="flex items-center gap-3">
            <span className="tabular-nums text-muted-foreground">{read.year}</span>
            <span className="font-semibold">{read.name}</span>
          </span>
          {read.done ? (
            <Check aria-hidden className="size-4 text-success-foreground" />
          ) : (
            <span className="size-2 rounded-full bg-muted-foreground/60" />
          )}
        </li>
      ))}
    </ul>
  );
}

function Copies({ words }: Words) {
  const s = words.shelf;
  return (
    <ul className="flex w-full max-w-xs flex-col gap-2">
      <li className={row}>
        <span className="flex items-center gap-2">
          <BookOpen aria-hidden className="size-4 text-primary" />
          {s.paperback}
        </span>
        <Badge variant="soft" size="sm">
          {s.owned}
        </Badge>
      </li>
      <li className={row}>
        <span className="flex items-center gap-2">
          <Library aria-hidden className="size-4 text-primary" />
          {s.borrowed}
        </span>
        <Badge variant="warning" size="sm">
          {fill(s.dueBack, { day: words.release.friday })}
        </Badge>
      </li>
    </ul>
  );
}

function Notes({ words }: Words) {
  return (
    <div className="w-full max-w-xs rounded-xl border border-border bg-background p-3 text-sm">
      <p lang="en" className="font-work-title">
        When a lantern goes out,{' '}
        <mark className="rounded bg-warning/25 px-0.5 text-foreground">
          its book can never be read again.
        </mark>
      </p>
      <p className="mt-3 flex items-center gap-2 border-t border-border pt-3 text-muted-foreground">
        <Lock aria-hidden className="size-3.5 shrink-0" />
        {words.library.private}
      </p>
    </div>
  );
}

function Reviews({ words }: Words) {
  const l = words.library;
  const scores = [
    { name: l.story, score: 5 },
    { name: l.translation, score: 4 },
    { name: l.narration, score: 3 },
  ];
  return (
    <ul className="flex w-full max-w-xs flex-col gap-2.5 text-sm">
      {scores.map(({ name, score }) => (
        <li key={name} className="flex items-center justify-between gap-3">
          <span>{name}</span>
          <span aria-hidden className="flex gap-1">
            {[1, 2, 3, 4, 5].map((n) => (
              <span
                key={n}
                className={cn('size-2.5 rounded-full', n <= score ? 'bg-primary' : 'bg-secondary')}
              />
            ))}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Export({ words }: Words) {
  const l = words.library;
  return (
    <div className="grid w-full max-w-2xl gap-2 sm:grid-cols-3">
      {[l.fileShelves, l.fileDates, l.fileNotes].map((name) => (
        <p key={name} className={row}>
          <span className="flex items-center gap-2">
            <FileSpreadsheet aria-hidden className="size-4 text-primary" />
            {name}
          </span>
          <Check aria-hidden className="size-4 text-success-foreground" />
        </p>
      ))}
    </div>
  );
}

export const readingVignettes: Record<string, Picture> = {
  formats: Formats,
  rereads: Rereads,
  copies: Copies,
  notes: Notes,
  reviews: Reviews,
  export: Export,
};
