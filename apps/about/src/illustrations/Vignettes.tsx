import { Badge } from '@rezics/ui/badge';
import { WorkCover } from '@rezics/ui/work-cover';
import { cn } from '@rezics/ui/utils';
import { Bot, Check, CircleDashed, Eye, EyeOff, MapPin, Megaphone, PenLine } from 'lucide-react';
import type { JSX } from 'react';
import { fill } from '../i18n/fill.ts';
import { localeNames } from '../i18n/locales.ts';
import { Connect, row, type Words } from './parts.tsx';
import { acgnVignettes } from './AcgnPictures.tsx';
import { communityVignettes } from './CommunityPictures.tsx';
import { developerVignettes } from './DeveloperPictures.tsx';
import { distributionVignettes } from './DistributionPictures.tsx';
import { trustVignettes } from './TrustPictures.tsx';
import { readingVignettes } from './ReadingPictures.tsx';
import { serialVignettes } from './SerialPictures.tsx';
import { cloths, lantern, world } from './sample.ts';

/**
 * Small pictures for showcase tiles (`Tile`'s `visual` slot), keyed by the tile they sit
 * in. Each shows one true scene in a few real UI pieces; tiles without a vignette show
 * their text alone.
 */

/* ---------- Light novels ---------- */

function Omnibus({ words }: Words) {
  return (
    <div className="flex items-end gap-4">
      <div className="relative">
        <WorkCover
          kind="book"
          id={lantern.id}
          title={lantern.editions[2].title}
          lang="en"
          authors={[lantern.author.en]}
          className="w-28 rounded-[5px]"
        />
        <span className="absolute inset-x-0 bottom-4 bg-(--cloth-ink) py-1 text-center text-xs font-bold text-(--cloth-reading)">
          {fill(words.shelf.volumes, { from: 1, to: 3 })}
        </span>
      </div>
      <ol className="flex items-end gap-1">
        {[1, 2, 3].map((volume) => (
          <li
            key={volume}
            className="flex h-24 w-6 items-end justify-center rounded-[3px] pb-1.5 text-xs font-bold"
            style={{ background: cloths.inkBlue.ground, color: cloths.inkBlue.ink }}
          >
            {volume}
          </li>
        ))}
      </ol>
    </div>
  );
}

function Calendar({ words }: Words) {
  const items = [
    { date: '10', lang: 'zh-Hant', volume: 7, dated: true },
    { date: '24', lang: 'ja', volume: 10, dated: false },
    { date: '28', lang: 'en', volume: 8, dated: false },
  ] as const;
  return (
    <ul className="flex w-full max-w-sm flex-col gap-2">
      {items.map((item) => (
        <li key={item.lang} className={row}>
          <span className="flex items-center gap-3">
            <span className="w-6 text-center text-lg font-bold tabular-nums">{item.date}</span>
            <span>
              <span className="font-semibold">{fill(words.shelf.volume, { n: item.volume })}</span>{' '}
              <span lang={item.lang} className="text-muted-foreground">
                {localeNames[item.lang]}
              </span>
            </span>
          </span>
          <Badge variant={item.dated ? 'success' : 'outline'} size="sm">
            {item.dated ? words.release.dated : words.release.expected}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

/* ---------- Wikis ---------- */

function Bible({ words }: Words) {
  const w = words.wiki;
  const entries = [
    { name: world.kaede, type: w.character },
    { name: world.archive, type: w.place },
    { name: 'The Lamplighters', type: w.faction },
    { name: 'The flood ledger', type: w.item },
    { name: 'Why the lanterns burn', type: w.lore },
  ];
  return (
    <ul className="grid w-full max-w-lg gap-2 sm:grid-cols-2">
      {entries.map((entry) => (
        <li key={entry.name} className={row}>
          <span lang="en" className="truncate font-semibold">
            {entry.name}
          </span>
          <span className="shrink-0 text-muted-foreground">{entry.type}</span>
        </li>
      ))}
    </ul>
  );
}

function Publish({ words }: Words) {
  const pages = [
    { name: world.kaede, open: true },
    { name: world.archive, open: true },
    { name: 'Ending notes', open: false },
  ];
  return (
    <ul className="flex w-full max-w-xs flex-col gap-2">
      {pages.map((page) => (
        <li key={page.name} className={row}>
          <span lang="en" className="truncate">
            {page.name}
          </span>
          <span
            className={cn(
              'flex shrink-0 items-center gap-1',
              page.open ? 'text-primary' : 'text-muted-foreground',
            )}
          >
            {page.open ? (
              <Eye aria-hidden className="size-4" />
            ) : (
              <EyeOff aria-hidden className="size-4" />
            )}
            {page.open ? words.wiki.public : words.wiki.private}
          </span>
        </li>
      ))}
    </ul>
  );
}

function WorldMap() {
  const pins = [
    { x: 30, y: 38, name: 'Archive' },
    { x: 64, y: 58, name: 'Ferry' },
    { x: 48, y: 24, name: 'Watch hill' },
  ];
  return (
    <div className="relative aspect-[4/3] w-full max-w-xs overflow-hidden rounded-2xl bg-[oklch(0.93_0.03_88)]">
      <svg viewBox="0 0 100 75" className="absolute inset-0 size-full" aria-hidden="true">
        <path
          d="M0 52 C18 44 26 58 40 50 S66 36 78 46 S94 60 100 54 L100 75 L0 75 Z"
          fill="oklch(0.62 0.06 210)"
          opacity="0.55"
        />
        <path
          d="M8 20 C20 12 34 18 44 14 S70 8 84 16"
          stroke="oklch(0.45 0.05 150)"
          strokeWidth="0.8"
          fill="none"
          strokeDasharray="2 2"
        />
      </svg>
      {pins.map((pin) => (
        <span
          key={pin.name}
          lang="en"
          className="absolute flex -translate-x-1/2 -translate-y-full flex-col items-center text-[0.6875rem] font-semibold text-[oklch(0.27_0.04_260)]"
          style={{ left: `${pin.x}%`, top: `${pin.y}%` }}
        >
          {pin.name}
          <MapPin aria-hidden className="size-4 fill-[var(--brand)] text-[oklch(0.3_0.08_25)]" />
        </span>
      ))}
    </div>
  );
}

function Timeline() {
  const events = [
    { at: 8, label: 'The flood' },
    { at: 46, label: 'Kaede arrives' },
    { at: 78, label: 'The ledger is found' },
  ];
  return (
    <div lang="en" className="w-full max-w-lg">
      <div className="flex justify-between text-xs text-muted-foreground tabular-nums">
        <span>Tide 409</span>
        <span>Tide 411</span>
        <span>Tide 413</span>
      </div>
      <div className="relative mt-3 h-24">
        <span className="absolute inset-x-0 top-6 h-0.5 rounded-full bg-border" />
        <span
          className="absolute top-5 h-2.5 rounded-full bg-primary/25"
          style={{ left: '2%', width: '16%' }}
        />
        {events.map((event) => (
          <span
            key={event.label}
            className="absolute top-4 flex -translate-x-1/2 flex-col items-center gap-2"
            style={{ left: `${event.at}%` }}
          >
            <span className="size-4 rounded-full border-2 border-card bg-primary" />
            <span className="whitespace-nowrap rounded-lg bg-background px-2 py-1 text-xs font-semibold">
              {event.label}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

function Diff() {
  return (
    <div
      lang="en"
      className="w-full max-w-sm overflow-hidden rounded-xl border border-border bg-background font-work-title text-sm"
    >
      <p className="bg-destructive/10 px-3 py-2 text-destructive-foreground line-through decoration-1">
        Ren has kept the archive for twenty years.
      </p>
      <p className="bg-success/10 px-3 py-2 text-success-foreground">
        Ren has kept the archive since the flood.<sup className="ms-0.5 font-sans text-xs">9</sup>
      </p>
    </div>
  );
}

/* ---------- Agents ---------- */

function SpamMini({ words }: Words) {
  const w = words.agent;
  return (
    <ul className="flex w-full max-w-md flex-col gap-2">
      <li className={row}>
        <span lang="en" className="truncate">
          All nine volumes free,{' '}
          <mark className="rounded bg-warning/25 px-0.5 text-foreground">DM me</mark>
        </span>
        <Badge variant="outline" size="sm" className="shrink-0">
          <Megaphone aria-hidden />
          {w.unsolicitedAd}
        </Badge>
      </li>
      <li className={row}>
        <span lang="en" className="truncate">
          <mark className="rounded bg-warning/25 px-0.5 text-foreground">
            Volume 7 of my series
          </mark>{' '}
          comes out Friday
        </span>
        <Badge variant="outline" size="sm" className="shrink-0">
          <PenLine aria-hidden />
          {w.ownWork}
        </Badge>
      </li>
    </ul>
  );
}

function Tagging({ words }: Words) {
  return (
    <div className="flex w-full max-w-xs flex-col gap-2">
      <p className="flex items-center gap-2 text-sm font-semibold">
        <Bot aria-hidden className="size-4 text-primary" />
        {words.agent.proposal}
      </p>
      <ul lang="en" className="flex flex-wrap gap-1.5">
        {['found family', 'slow burn', 'Vol. 3'].map((tag) => (
          <li key={tag}>
            <Badge variant="outline" size="md">
              {tag}
            </Badge>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Relation({ words }: Words) {
  return (
    <div className="flex w-full max-w-xs flex-col items-start gap-2">
      <Badge variant="info" size="sm">
        <Bot aria-hidden />
        {words.agent.proposedLink}
      </Badge>
      <p lang="en" className="flex flex-wrap items-center gap-2 text-sm">
        <span className="rounded-full bg-primary px-3 py-1 font-semibold text-primary-foreground">
          {world.iori}
        </span>
        <span className="h-px w-6 border-t-2 border-dashed border-primary" />
        <span className="rounded-full border border-border bg-background px-3 py-1 font-semibold">
          {world.archive}
        </span>
      </p>
    </div>
  );
}

function Normalise() {
  return (
    <div lang="en" className="flex w-full max-w-xs flex-col gap-2 text-sm">
      <p className="rounded-xl border border-border bg-background px-3 py-2 italic text-muted-foreground">
        so you take two eggs, a cup of rice, then fry it all with the leftover…
      </p>
      <ul className="rounded-xl border border-primary/50 bg-background px-3 py-2">
        <li className="flex items-center gap-2">
          <Check aria-hidden className="size-3.5 text-primary" />2 eggs
        </li>
        <li className="flex items-center gap-2">
          <Check aria-hidden className="size-3.5 text-primary" />1 cup cooked rice
        </li>
      </ul>
    </div>
  );
}

function Migration({ words }: Words) {
  const w = words.agent;
  return (
    <ul className="flex w-full max-w-xs flex-col gap-2">
      <li className={row}>
        <span>{fill(w.matchedCount, { n: 212 })}</span>
        <Check aria-hidden className="size-4 text-success-foreground" />
      </li>
      <li className={cn(row, 'border-primary')}>
        <span>{fill(w.chooseCount, { n: 6 })}</span>
        <span className="size-2 rounded-full bg-primary" />
      </li>
      <li className={row}>
        <span>{fill(w.unmatchedCount, { n: 3 })}</span>
        <CircleDashed aria-hidden className="size-4 text-muted-foreground" />
      </li>
    </ul>
  );
}

function Builder({ words }: Words) {
  return (
    <div className="w-full max-w-sm rounded-xl border border-border bg-background p-3 text-sm">
      <p className="flex items-center justify-between gap-2">
        <span lang="en" className="font-semibold">
          {world.archive}
        </span>
        <Badge variant="info" size="sm">
          <Bot aria-hidden />
          {words.agent.proposedFact}
        </Badge>
      </p>
      <p lang="en" className="mt-2 font-work-title">
        Lights one lantern for every book on loan.
        <sup className="ms-0.5 font-sans text-xs font-semibold text-primary">
          {fill(words.shelf.chapter, { n: 4 })}
        </sup>
      </p>
    </div>
  );
}

const vignettes = {
  reading: readingVignettes,
  'serial-fiction': serialVignettes,
  acgn: acgnVignettes,
  communities: communityVignettes,
  distribution: distributionVignettes,
  developers: developerVignettes,
  trust: trustVignettes,
  'light-novels': { omnibus: Omnibus, calendar: Calendar },
  wikis: { bible: Bible, publish: Publish, maps: WorldMap, timelines: Timeline, history: Diff },
  agents: {
    'spam-review': SpamMini,
    'auto-tagging': Tagging,
    'relation-maintenance': Relation,
    normalisation: Normalise,
    'migration-assistant': Migration,
    'wiki-builder': Builder,
    byo: Connect,
  },
} as const;

export type VignettePage = keyof typeof vignettes;

/** The tile keys of a page that have a vignette. */
export function vignetteKeys(page: VignettePage): string[] {
  return Object.keys(vignettes[page]);
}

export function Vignette({ page, tile, words }: { page: VignettePage; tile: string } & Words) {
  const Picture = (vignettes[page] as Record<string, (props: Words) => JSX.Element>)[tile];
  return Picture ? <Picture words={words} /> : null;
}
