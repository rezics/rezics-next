import { cn } from '@rezics/ui/utils';
import type { ZoneText, ZoneWork } from '@rezics/zone-sdk';
import { StampIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import type { UiLocale } from '../../i18n/define.ts';
import { BFF_PREFIX } from '../api/browser.ts';
import { messages as catalogueMessages } from '../catalogue/messages.ts';
import type { CatalogueWork } from '../catalogue/work.ts';
import { AuthorNames } from '../catalogue/author-names.tsx';
import { CoverLink, WorkTile } from '../catalogue/work-tile.tsx';
import LocalizedLink from '../shell/localized-link.tsx';
import type { ZoneMessages } from './messages.ts';

// Zone modules draw Works with the catalogue's tiles and covers, so a Work
// looks the same in a Zone as on Discover, Search and its own page. The
// Zone's own marks, the chart position and the stamp that opens the
// Decision behind the pick, sit beside the title and never on the cover,
// whose own title they would hide.

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
    kind: work.kind, authors: work.author ? [{ name: work.author.value, href: work.authorHref ?? null }] : [],
    rating: null,
    tagline: work.tagline ? name(work.tagline) : null, completion: work.status };
}

/**
 * The link to the public Decision that placed a Work here: a stamp that says
 * "Why it's here" on hover and focus. It sits outside package slots, so a
 * Zone design can restyle a card but never hide why a pick is in the Zone.
 */
export function WhyHere({ work, locale, messages, className }: {
  work: Pick<ZoneWork, 'title' | 'decision'>; locale: UiLocale; messages: ZoneMessages; className?: string;
}) {
  if (!work.decision) return null;
  const t = materializeData(messages, { locale });
  return <LocalizedLink href={work.decision} aria-label={t.whyHere({ title: workTitle(work, messages) })}
    className={cn('group/why pointer-events-auto relative z-10 inline-grid size-7 shrink-0 place-items-center rounded-full',
      'text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground',
      'focus-visible:ring-2 focus-visible:ring-ring', className)}>
    <StampIcon aria-hidden="true" className="size-3.5" />
    <span aria-hidden="true" className="pointer-events-none absolute end-0 bottom-full z-20 mb-1 w-max max-w-48
      rounded-md bg-foreground px-2 py-1 font-medium text-background text-xs opacity-0 shadow-md transition-opacity
      group-hover/why:opacity-100 group-focus-visible/why:opacity-100 motion-reduce:transition-none">
      {catalogueMessages[locale].whyItsHere}</span>
  </LocalizedLink>;
}

function RankBadge({ rank, label, className }: { rank: number; label: string; className?: string }) {
  return <span className={cn('grid h-6 min-w-6 shrink-0 place-items-center rounded-full px-1.5 font-semibold text-xs',
    'tabular-nums', rank <= 3 ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground', className)}>
    <span className="sr-only">{label}</span><span aria-hidden="true">{rank}</span></span>;
}

/** How long ago a moment was, in the reader's language (`3 days ago`, `last month`). */
export function agoText(at: string, locale: UiLocale, now = Date.now()): string | null {
  const time = Date.parse(at);
  if (Number.isNaN(time)) return null;
  const days = Math.max(0, Math.floor((now - time) / 86_400_000));
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  return days < 30 ? format.format(-days, 'day') : days < 365 ? format.format(-Math.floor(days / 30), 'month')
    : format.format(-Math.floor(days / 365), 'year');
}

/**
 * What a reader checks before opening a Work, as its field's sites list it: a
 * mod's environment, loaders and game versions (Modrinth), a serial's status,
 * chapters and length (novel sites), and when it last changed. Each fact is
 * Main's; a Work without one shows nothing for it.
 */
export function WorkFacts({ work, locale, messages, className }: {
  work: ZoneWork; locale: UiLocale; messages: ZoneMessages; className?: string;
}) {
  const t = materializeData(messages, { locale });
  const { mod } = work;
  const exact = mod?.selected;
  const at = exact?.publishedAt ?? mod?.updatedAt ?? work.latestChapter?.at ?? work.updatedAt;
  const ago = at ? agoText(at, locale) : null;
  const versions = exact?.gameVersions ?? [];
  const facts = [
    exact?.side ? { key: 'env', text: exact.side === 'client' ? messages.envClient : messages.envServer } : null,
    ...(exact?.loaders ?? []).map(loader => ({ key: loader, text: loader, code: true })),
    ...versions.slice(0, 3).map(version => ({ key: version, text: version, code: true })),
    versions.length > 3 ? { key: 'more', text: `+${versions.length - 3}` } : null,
    work.status ? { key: 'status', text: { ongoing: messages.statusOngoing, completed: messages.statusCompleted,
      hiatus: messages.statusHiatus }[work.status] } : null,
    work.chapters ? { key: 'chapters', text: t.chapters(work.chapters) } : null,
    work.words ? { key: 'words', text: t.words({ count: new Intl.NumberFormat(locale, { notation: 'compact' })
      .format(work.words) }) } : null,
  ].filter(fact => fact !== null);
  if (!facts.length && !ago) return null;
  return <ul className={cn('flex flex-wrap items-center gap-1.5 text-muted-foreground text-xs', className)}>
    {facts.map(fact => <li key={fact.key} translate={'code' in fact ? 'no' : undefined}
      className="rounded-full border border-border/80 px-2 py-0.5 leading-tight">{fact.text}</li>)}
    {ago ? <li className="ms-0.5"><time dateTime={at ?? undefined}>{t.updated({ ago })}</time></li> : null}
  </ul>;
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
 * position before its title and the "Why here?" stamp after it.
 */
export function ZoneWorkCard({ work, rank, slot = 2 / 3, locale, messages, avatarQuery, headingLevel = 3,
  whyHere = true }: ZoneCardProps & {
  /** The row's tallest cover proportion (`slotRatio`), so titles line up. */
  slot?: number;
}) {
  const t = materializeData(messages, { locale });
  return <WorkTile work={catalogueWork(work)} slot={slot} headingLevel={headingLevel} avatarQuery={avatarQuery}
    locale={locale}
    titleStart={rank ? <RankBadge rank={rank} label={t.rank({ rank: String(rank) })} className="mt-px" /> : null}
    titleEnd={whyHere ? <WhyHere work={work} locale={locale} messages={messages} className="-me-1 -mt-0.5" /> : null} />;
}

/**
 * A Work as a compact row, for rails, charts past the podium and editor
 * lists: the chart position, a small catalogue cover, the title in the
 * Work-title face, the author and the one-line hook. Covers stay wide enough (4.5rem) for a
 * generated cover to set its title, so no row shows a blank block.
 */
export function ZoneWorkRow({ work, rank, locale, messages, avatarQuery, headingLevel = 3, whyHere = true,
  compact = false }: ZoneCardProps & {
  /** Rails: a smaller cover and a one-line hook. */
  compact?: boolean;
}) {
  const t = materializeData(messages, { locale });
  const Heading = `h${headingLevel}` as const;
  const title = workTitle(work, messages);
  const card = catalogueWork(work);
  const exact = work.mod?.selected;
  const required = exact?.dependencies?.filter(item => item.requirement === 'required'
    && (!item.side || item.side === exact.side)) ?? [];
  // A chart's position leads the row in its own column, clear of the cover.
  return <article className={cn('group/tile relative grid items-start gap-x-3', rank
    ? compact ? 'grid-cols-[auto_4.5rem_minmax(0,1fr)_auto]' : 'grid-cols-[auto_5rem_minmax(0,1fr)_auto]'
    : compact ? 'grid-cols-[4.5rem_minmax(0,1fr)_auto]' : 'grid-cols-[5rem_minmax(0,1fr)_auto]')}>
    {rank ? <RankBadge rank={rank} label={t.rank({ rank: String(rank) })} className="mt-1" /> : null}
    <CoverLink work={card} avatarQuery={avatarQuery} />
    <div className="grid min-w-0 content-start gap-0.5">
      <Heading lang={work.title?.lang} dir={work.title?.dir}
        className={cn('text-pretty font-medium font-work-title', compact ? 'line-clamp-1 text-[0.9375rem]/snug'
          : 'line-clamp-2 text-base/snug')}>
        <LocalizedLink href={work.href} className="rounded-sm outline-none decoration-1 underline-offset-2
          hover:underline focus-visible:ring-2 focus-visible:ring-ring">{title}</LocalizedLink>
      </Heading>
      {work.author ? <p lang={work.author.lang} className="truncate text-muted-foreground text-sm">
        <AuthorNames authors={card.authors} /></p> : null}
      {work.tagline ? <p lang={work.tagline.lang} dir={work.tagline.dir} className={cn('text-pretty',
        'text-muted-foreground text-sm/snug', compact ? 'line-clamp-1' : 'line-clamp-2')}>{work.tagline.value}</p>
        : null}
      {work.mod ? exact ? <div data-release-state={exact.state}
        className="grid gap-0.5 text-muted-foreground text-xs">
        <p>{exact.state === 'stale' ? messages.modOlderCompatible : `${messages.modCompatibility}:`}
          {' '}<strong translate="no">{exact.version ?? '—'}</strong>
          {' · '}{exact.channel === 'beta' ? messages.modChannelBeta
            : exact.channel === 'alpha' ? messages.modChannelAlpha
              : exact.channel === 'release' ? messages.modChannelRelease : messages.modChannelUnknown}</p>
        <p>{exact.dependencies === null ? messages.modDependenciesUnknown
          : required.length ? `${messages.modRequired}: ${required.map(item => item.id).join(', ')}`
            : messages.modNoDependencies}</p>
      </div> : <p className="text-muted-foreground text-xs">{messages.modChooseForDetails}</p> : null}
      {work.latestChapter?.title ? <p lang={work.latestChapter.title.lang} className="line-clamp-1 text-primary text-sm">
        <LocalizedLink href={work.latestChapter.href} className="rounded-sm outline-none hover:underline
          focus-visible:ring-2 focus-visible:ring-ring">{t.newChapter({ chapter: work.latestChapter.title.value })}
        </LocalizedLink></p> : null}
      {compact ? null : <WorkFacts work={work} locale={locale} messages={messages} className="mt-1" />}
    </div>
    {whyHere ? <WhyHere work={work} locale={locale} messages={messages} className="-me-1 -mt-1" /> : <span />}
  </article>;
}
