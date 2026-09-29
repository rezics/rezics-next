import { Badge } from '@rezics/ui/badge';
import { cn } from '@rezics/ui/utils';
import { Bell, Check } from 'lucide-react';
import type { CSSProperties } from 'react';
import { fill } from '../i18n/fill.ts';
import { localeNames } from '../i18n/locales.ts';
import type { IllustrationCopy } from '../i18n/messages/illustrations.ts';
import { Plate } from './Plate.tsx';
import { cloths, lantern } from './sample.ts';

type Mark = 'read' | 'reading' | 'owned';
type Kind = 'original' | 'official' | 'fan' | 'machine';

interface Row {
  lang: 'ja' | 'en' | 'zh-Hant' | 'es';
  title: string;
  kind: Kind;
  /** Volume numbers on the shelf. */
  volumes: number[];
  by?: string;
  marks?: Partial<Record<number, Mark>>;
  /** A dated volume that is not out yet. */
  upcoming?: number;
}

const title = (lang: 'ja' | 'en' | 'zh-Hant') =>
  lantern.editions.find((edition) => edition.lang === lang)!.title;
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => from + index);

const editions: Row[] = [
  {
    lang: 'ja',
    title: title('ja'),
    kind: 'original',
    volumes: range(1, 9),
    marks: { 1: 'owned', 2: 'owned', 3: 'owned' },
  },
  { lang: 'en', title: title('en'), kind: 'official', volumes: range(1, 7), by: 'Aya Linden' },
  {
    lang: 'zh-Hant',
    title: title('zh-Hant'),
    kind: 'official',
    volumes: range(1, 6),
    by: '林映雪',
    marks: { 1: 'read', 2: 'read', 3: 'read', 4: 'read', 5: 'read', 6: 'reading' },
    upcoming: 7,
  },
];

const translations: Row[] = [
  { lang: 'ja', title: title('ja'), kind: 'original', volumes: range(1, 9) },
  { lang: 'en', title: title('en'), kind: 'official', volumes: range(1, 7), by: 'Aya Linden' },
  { lang: 'en', title: title('en'), kind: 'fan', volumes: range(8, 9), by: 'Night Ferry TL' },
  { lang: 'es', title: 'El archivo de los faroles', kind: 'machine', volumes: range(1, 2) },
];

/** Each edition's publisher dresses it differently; the original keeps the series' ink blue. */
const cloth: Record<string, (typeof cloths)[keyof typeof cloths]> = {
  'ja-original': cloths.inkBlue,
  'en-official': cloths.oxblood,
  'zh-Hant-official': cloths.teal,
  'en-fan': cloths.ochre,
  'es-machine': cloths.plum,
};

function Spine({
  row,
  volume,
  mark,
  ghost = false,
  compact = false,
}: {
  row: Row;
  volume: number;
  mark?: Mark;
  ghost?: boolean;
  compact?: boolean;
}) {
  const swatch = cloth[`${row.lang}-${row.kind}`] ?? cloths.inkBlue;
  const latin = row.lang === 'en' || row.lang === 'es';
  return (
    <li className="relative flex flex-col items-center gap-1.5">
      <div
        className={cn(
          'relative flex w-6 flex-col items-center justify-between overflow-hidden rounded-[3px] py-2 sm:w-8',
          compact ? 'h-24 sm:h-28' : 'h-28 sm:h-40',
          ghost
            ? 'border-2 border-dashed border-primary/70 bg-transparent text-primary'
            : 'shadow-[inset_-3px_0_0_rgb(0_0_0/0.18),inset_2px_0_0_rgb(255_255_255/0.12)]',
        )}
        style={ghost ? undefined : { background: swatch.ground, color: swatch.ink }}
      >
        {ghost ? null : (
          <span className="h-px w-3/5 shrink-0 opacity-80" style={{ background: swatch.accent }} />
        )}
        <span
          lang={row.lang}
          className={cn(
            'min-h-0 overflow-hidden font-work-title leading-none [writing-mode:vertical-rl]',
            latin
              ? 'text-[0.5625rem] font-semibold tracking-[0.06em] sm:text-[0.6875rem]'
              : 'text-[0.6875rem] font-semibold tracking-[0.12em] sm:text-sm',
            ghost && 'opacity-0',
          )}
        >
          {row.title}
        </span>
        <span className="shrink-0 text-[0.6875rem] font-bold tabular-nums sm:text-xs">
          {volume}
        </span>
      </div>
      <span className="flex h-4 items-center">
        {mark === 'read' ? (
          <span className="flex size-4 items-center justify-center rounded-full bg-success-foreground text-background">
            <Check aria-hidden className="size-2.5" strokeWidth={3} />
          </span>
        ) : mark === 'owned' ? (
          <span className="size-2 rounded-full bg-primary" />
        ) : null}
      </span>
      {mark === 'reading' ? (
        <span className="ribbon absolute -top-2 left-1/2 h-12 w-2.5 -translate-x-1/2 sm:h-16 sm:w-3" />
      ) : null}
    </li>
  );
}

function kindLabel(kind: Kind, words: IllustrationCopy['release']) {
  return {
    original: words.original,
    official: words.official,
    fan: words.fan,
    machine: words.machine,
  }[kind];
}

/**
 * One light novel series across its editions, as spines on a shelf: the Japanese original
 * set vertically, the translations in their own scripts. `marks` shows what the reader owns
 * and has read (the ribbon is their place), `upcoming` adds the dated next volume and its
 * note, and `provenance` lists every translation with who made it.
 */
export function SeriesBoard({
  words,
  marks = false,
  upcoming = false,
  provenance = false,
  className,
}: {
  words: IllustrationCopy;
  marks?: boolean;
  upcoming?: boolean;
  provenance?: boolean;
  className?: string;
}) {
  const rows = provenance ? translations : editions;
  return (
    <Plate className={cn('relative', className)}>
      <div className={cn('flex flex-col', provenance ? 'gap-3' : 'gap-5')}>
        {rows.map((row, index) => (
          <div
            key={`${row.lang}-${row.kind}`}
            data-arrive={provenance ? '' : undefined}
            style={{ '--at': index * 6 } as CSSProperties}
          >
            <p className="mb-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
              <span lang={row.lang} className="font-semibold">
                {localeNames[row.lang as 'en']}
              </span>
              {provenance ? (
                <Badge
                  variant={
                    row.kind === 'machine'
                      ? 'warning'
                      : row.kind === 'fan'
                        ? 'info'
                        : row.kind === 'official'
                          ? 'success'
                          : 'outline'
                  }
                  size="sm"
                >
                  {kindLabel(row.kind, words.release)}
                </Badge>
              ) : (
                <span className="text-muted-foreground">{kindLabel(row.kind, words.release)}</span>
              )}
              {provenance && row.by ? (
                <span className="text-muted-foreground">
                  {fill(words.release.translatedBy, { name: row.by })}
                </span>
              ) : null}
            </p>
            <ol className="flex items-start gap-1 sm:gap-1.5">
              {row.volumes.map((volume) => (
                <Spine
                  key={volume}
                  row={row}
                  volume={volume}
                  mark={marks ? row.marks?.[volume] : undefined}
                  compact={provenance}
                />
              ))}
              {upcoming && row.upcoming ? <Spine row={row} volume={row.upcoming} ghost /> : null}
            </ol>
          </div>
        ))}
      </div>
      {upcoming ? (
        <div
          data-arrive
          style={{ '--at': 8 } as CSSProperties}
          className="absolute -bottom-6 end-4 flex max-w-[calc(100%-2rem)] items-center gap-3 rounded-2xl border border-border bg-popover px-4 py-3 text-popover-foreground shadow-(--aura-shadow-float) sm:end-6"
        >
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <Bell aria-hidden className="size-4" />
          </span>
          <span className="min-w-0">
            <span className="block font-semibold">
              {fill(words.release.note, { n: 7, language: localeNames['zh-Hant'] })}
            </span>
            <span className="block text-sm text-muted-foreground">
              {fill(words.release.out, { day: words.release.friday })}
            </span>
          </span>
        </div>
      ) : null}
    </Plate>
  );
}

/**
 * The light novels hero: one edition's volumes standing tall, the reader's place marked by
 * the ribbon, the next volume a dashed outline with its date, and the note that says so.
 */
export function SeriesShelf({ words, className }: { words: IllustrationCopy; className?: string }) {
  const row = editions.find((edition) => edition.lang === 'zh-Hant')!;
  const swatch = cloth['zh-Hant-official']!;
  return (
    <div aria-hidden="true" data-illustration className={cn('relative w-full pb-20', className)}>
      <ol className="flex items-end justify-center gap-1.5 border-b-[6px] border-(--cloth-ink)/25 px-2 sm:gap-2.5">
        {[...row.volumes, row.upcoming!].map((volume) => {
          const ghost = volume === row.upcoming;
          return (
            <li key={volume} className="relative">
              <div
                className={cn(
                  'flex h-52 w-9 flex-col items-center justify-between rounded-t-[4px] py-3 sm:h-72 sm:w-14',
                  ghost
                    ? 'border-2 border-b-0 border-dashed border-(--cloth-ink)/70'
                    : 'shadow-[inset_-4px_0_0_rgb(0_0_0/0.22),inset_3px_0_0_rgb(255_255_255/0.12)]',
                )}
                style={ghost ? undefined : { background: swatch.ground, color: swatch.ink }}
              >
                <span
                  className={cn('h-0.5 w-1/2', ghost && 'invisible')}
                  style={{ background: swatch.accent }}
                />
                <span
                  lang="zh-Hant"
                  className={cn(
                    'font-work-title text-base font-semibold tracking-[0.2em] [writing-mode:vertical-rl] sm:text-xl',
                    ghost && 'invisible',
                  )}
                >
                  {row.title}
                </span>
                <span className="text-sm font-bold tabular-nums sm:text-base">{volume}</span>
              </div>
              {row.marks?.[volume] === 'reading' ? (
                <span className="ribbon absolute -top-3 left-1/2 h-24 w-3 -translate-x-1/2 sm:h-32 sm:w-4" />
              ) : null}
            </li>
          );
        })}
      </ol>
      <div
        data-arrive
        className="absolute bottom-0 end-0 flex items-center gap-3 rounded-2xl bg-(--cloth-ink) px-4 py-3 text-[oklch(0.25_0.03_260)] shadow-(--aura-shadow-float) sm:end-4"
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[oklch(0.36_0.09_255)] text-(--cloth-ink)">
          <Bell aria-hidden className="size-4" />
        </span>
        <span>
          <span className="block font-semibold">
            {fill(words.release.note, { n: row.upcoming!, language: localeNames['zh-Hant'] })}
          </span>
          <span className="block text-sm opacity-80">
            {fill(words.release.out, { day: words.release.friday })}
          </span>
        </span>
      </div>
    </div>
  );
}
