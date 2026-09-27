import { cn } from '@rezics/ui/utils';
import type { ZoneWork } from '@rezics/zone-sdk';
import { StampIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import type { UiLocale } from '../../i18n/define.ts';
import LocalizedLink from '../shell/localized-link.tsx';
import { ZoneCover } from './cover.tsx';
import type { ZoneMessages } from './messages.ts';

/** A Work's title in its own language, or the untitled stand-in. */
export function workTitle(work: Pick<ZoneWork, 'title'>, messages: ZoneMessages): string {
  return work.title?.value ?? messages.untitled;
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
    className={cn('relative z-10 inline-grid size-6 shrink-0 place-items-center rounded-full text-muted-foreground',
      'outline-none transition-colors hover:bg-accent hover:text-accent-foreground',
      'focus-visible:ring-2 focus-visible:ring-ring', className)}>
    <StampIcon aria-hidden="true" className="size-3.5" />
  </LocalizedLink>;
}

function RankBadge({ rank, label }: { rank: number; label: string }) {
  return <span className={cn('pointer-events-none absolute bottom-1.5 start-1.5 z-10 grid h-6 min-w-6 place-items-center',
    'rounded-full px-1.5 font-semibold text-xs tabular-nums shadow-sm ring-2 ring-card',
    rank <= 3 ? 'bg-primary text-primary-foreground' : 'bg-card text-foreground')}>
    <span className="sr-only">{label}</span><span aria-hidden="true">{rank}</span></span>;
}

function StatusBadge({ work, messages }: { work: ZoneWork; messages: ZoneMessages }) {
  if (work.status !== 'completed') return null;
  return <span className="pointer-events-none absolute end-1.5 top-1.5 z-10 rounded-full bg-black/60 px-2 py-0.5 font-medium
    text-[0.65rem] text-white backdrop-blur-sm">{messages.completed}</span>;
}

export interface ZoneWorkCardProps {
  work: ZoneWork;
  layout?: 'cover' | 'row';
  rank?: number;
  locale: UiLocale;
  messages: ZoneMessages;
  headingLevel?: 3 | 4;
  /** False when the caller places the stamp itself, around a package's card. */
  whyHere?: boolean;
}

/**
 * A Work in a Zone module: the cover is the card, with the title, the
 * author and the one-line hook under it. The whole card opens the Work; the
 * stamp opens the Decision that placed it here.
 */
export function ZoneWorkCard({ work, layout = 'cover', rank, locale, messages, headingLevel = 3, whyHere = true }:
  ZoneWorkCardProps) {
  const t = materializeData(messages, { locale });
  const Heading = `h${headingLevel}` as const;
  const title = workTitle(work, messages);
  const row = layout === 'row';
  return <article className={cn('zone-card group relative flex min-w-0', row ? 'flex-row gap-3' : 'flex-col gap-2')}>
    <span className={cn('relative block', row ? 'w-16 shrink-0 sm:w-19' : 'w-full')}>
      <ZoneCover work={work} className="transition-transform duration-200 group-hover:-translate-y-0.5
        motion-reduce:transition-none" />
      {rank ? <RankBadge rank={rank} label={t.rank({ rank: String(rank) })} /> : null}
      <StatusBadge work={work} messages={messages} />
    </span>
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <div className="flex items-start gap-1">
        <Heading lang={work.title?.lang} dir={work.title?.dir}
          className={cn('min-w-0 flex-1 font-medium text-sm/snug', row ? 'line-clamp-2' : 'line-clamp-1')}>
          <LocalizedLink href={work.href} className="outline-none after:absolute after:inset-0 after:z-0
            after:rounded-(--zone-radius-cover) group-hover:text-primary focus-visible:after:ring-2
            focus-visible:after:ring-ring">{title}</LocalizedLink>
        </Heading>
        {whyHere ? <WhyHere work={work} locale={locale} messages={messages} className="-me-1 -mt-0.5" /> : null}
      </div>
      {work.author ? <p lang={work.author.lang} className="line-clamp-1 text-muted-foreground text-xs">
        {work.author.value}</p> : null}
      {work.tagline ? <p lang={work.tagline.lang} dir={work.tagline.dir}
        className="line-clamp-2 text-pretty text-muted-foreground text-xs/relaxed">{work.tagline.value}</p> : null}
      {row && work.latestChapter?.title ? <p className="line-clamp-1 text-primary text-xs">
        {t.newChapter({ chapter: work.latestChapter.title.value })}</p> : null}
    </div>
  </article>;
}
