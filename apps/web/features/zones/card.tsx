import { cn } from '@rezics/ui/utils';
import type { ZoneText, ZoneWork } from '@rezics/zone-sdk';
import { StampIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import type { ReactNode } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { BFF_PREFIX } from '../api/browser.ts';
import type { CatalogueWork } from '../catalogue/work.ts';
import { CoverLink, WorkTile } from '../catalogue/work-tile.tsx';
import LocalizedLink from '../shell/localized-link.tsx';
import type { ZoneMessages } from './messages.ts';

// Zone modules draw Works with the catalogue's tiles and covers, so a Work
// looks the same in a Zone as on Discover, Search and its own page. The
// Zone adds two marks on the cover: the chart position and the stamp that
// opens the Decision behind the pick.

/** A Work's title in its own language, or the untitled stand-in. */
export function workTitle(work: Pick<ZoneWork, 'title'>, messages: ZoneMessages): string {
  return work.title?.value ?? messages.untitled;
}

const name = (text: ZoneText) => ({ value: text.value, language: text.lang, direction: text.dir,
  basis: 'requested' as const });

/**
 * A Zone Work as the catalogue takes it. Covers load only from Main's media
 * paths, as on every other surface; the reader's `avatarQuery` goes on by the
 * tile, so any query on the Zone's image URL is dropped here.
 */
export function catalogueWork(work: ZoneWork): CatalogueWork {
  const path = work.cover?.url.split('?')[0];
  const media = path?.startsWith(`${BFF_PREFIX}/v1/media/`) ? path.slice(BFF_PREFIX.length) : null;
  return { id: work.id, href: work.href, title: work.title ? name(work.title) : null,
    // Only the fields the catalogue's cover reads; the rest of Main's avatar shape is not needed here.
    cover: media && work.cover ? { kind: 'image', url: media, width: work.cover.width, height: work.cover.height,
      selection: '', mediaType: '', crop: null, basis: { policy: '', context: '' } } : null,
    kind: work.kind, authors: work.author ? [work.author.value] : [], rating: null,
    tagline: work.tagline ? name(work.tagline) : null, completion: work.status };
}

/**
 * The link to the public Decision that placed a Work here. It sits outside
 * package slots, so a Zone design can restyle a card but never hide why a
 * pick is in the Zone.
 */
export function WhyHere({ work, locale, messages, className }: {
  work: Pick<ZoneWork, 'title' | 'decision'>; locale: UiLocale; messages: ZoneMessages; className?: string;
}) {
  if (!work.decision) return null;
  const t = materializeData(messages, { locale });
  const label = t.whyHere({ title: workTitle(work, messages) });
  return <LocalizedLink href={work.decision} aria-label={label} title={label}
    className={cn('pointer-events-auto relative z-10 inline-grid size-7 shrink-0 place-items-center rounded-full',
      'text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground',
      'focus-visible:ring-2 focus-visible:ring-ring', className)}>
    <StampIcon aria-hidden="true" className="size-3.5" />
  </LocalizedLink>;
}

function RankBadge({ rank, label, className }: { rank: number; label: string; className?: string }) {
  return <span className={cn('pointer-events-none grid h-6 min-w-6 place-items-center rounded-full px-1.5',
    'font-semibold text-xs tabular-nums shadow-[0_1px_4px_rgb(0_0_0/0.25)]',
    rank <= 3 ? 'bg-primary text-primary-foreground' : 'bg-background/92 text-foreground backdrop-blur', className)}>
    <span className="sr-only">{label}</span><span aria-hidden="true">{rank}</span></span>;
}

/** The cover area of a tile, for marks placed on its corners. */
function CoverMarks({ slot, children }: { slot: number; children: ReactNode }) {
  return <div className="pointer-events-none absolute inset-x-0 top-0 z-30" style={{ aspectRatio: String(slot) }}>
    {children}</div>;
}

export interface ZoneCardProps {
  work: ZoneWork;
  rank?: number;
  locale: UiLocale;
  messages: ZoneMessages;
  avatarQuery?: string;
  headingLevel?: 2 | 3 | 4;
  /** False when the caller places the stamp itself, around a package's card. */
  whyHere?: boolean;
}

/**
 * A Work in a shelf, chart or grid: the catalogue's tile, with the chart
 * position on the cover's top corner and the "Why here?" stamp on its foot.
 */
export function ZoneWorkCard({ work, rank, slot = 2 / 3, locale, messages, avatarQuery, headingLevel = 3,
  whyHere = true }: ZoneCardProps & {
  /** The row's tallest cover proportion (`slotRatio`), so titles line up. */
  slot?: number;
}) {
  const t = materializeData(messages, { locale });
  return <div className="relative min-w-0">
    <WorkTile work={catalogueWork(work)} slot={slot} headingLevel={headingLevel} avatarQuery={avatarQuery}
      locale={locale} />
    <CoverMarks slot={slot}>
      {rank ? <RankBadge rank={rank} label={t.rank({ rank: String(rank) })} className="absolute start-2 top-2" /> : null}
      {whyHere ? <WhyHere work={work} locale={locale} messages={messages}
        className="absolute end-2 bottom-2 bg-background/92 text-foreground shadow-[0_1px_4px_rgb(0_0_0/0.18)]
          backdrop-blur hover:bg-background" /> : null}
    </CoverMarks>
  </div>;
}

/**
 * A Work as a compact row, for rails, charts past the podium and editor
 * lists: a small catalogue cover, the title in the Work-title face, the
 * author and the one-line hook.
 */
export function ZoneWorkRow({ work, rank, locale, messages, avatarQuery, headingLevel = 3, whyHere = true,
  compact = false }: ZoneCardProps & {
  /** Rails: a smaller cover and a one-line hook. */
  compact?: boolean;
}) {
  const t = materializeData(messages, { locale });
  const Heading = `h${headingLevel}` as const;
  const title = workTitle(work, messages);
  return <article className={cn('group/tile relative grid items-start gap-x-3',
    compact ? 'grid-cols-[2.75rem_minmax(0,1fr)_auto]' : 'grid-cols-[4rem_minmax(0,1fr)_auto]')}>
    <CoverLink work={catalogueWork(work)} avatarQuery={avatarQuery}>
      {rank ? <RankBadge rank={rank} label={t.rank({ rank: String(rank) })} className="absolute -start-1.5 -top-1.5 z-20" />
        : null}
    </CoverLink>
    <div className="grid min-w-0 content-start gap-0.5">
      <Heading lang={work.title?.lang} dir={work.title?.dir}
        className={cn('text-pretty font-medium font-work-title', compact ? 'line-clamp-1 text-[0.9375rem]/snug'
          : 'line-clamp-2 text-base/snug')}>
        <LocalizedLink href={work.href} className="rounded-sm outline-none decoration-1 underline-offset-2
          hover:underline focus-visible:ring-2 focus-visible:ring-ring">{title}</LocalizedLink>
      </Heading>
      {work.author ? <p lang={work.author.lang} className="truncate text-muted-foreground text-sm">
        {work.author.value}</p> : null}
      {work.tagline ? <p lang={work.tagline.lang} dir={work.tagline.dir} className={cn('text-pretty',
        'text-muted-foreground text-sm/snug', compact ? 'line-clamp-1' : 'line-clamp-2')}>{work.tagline.value}</p>
        : null}
      {work.latestChapter?.title ? <p className="line-clamp-1 text-primary text-sm">
        {t.newChapter({ chapter: work.latestChapter.title.value })}</p> : null}
    </div>
    {whyHere ? <WhyHere work={work} locale={locale} messages={messages} className="-me-1 -mt-1" /> : <span />}
  </article>;
}
