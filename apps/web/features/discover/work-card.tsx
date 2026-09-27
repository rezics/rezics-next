import { Badge } from '@rezics/ui/badge';
import { cn } from '@rezics/ui/utils';
import { StarIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import Link from '../shell/localized-link.tsx';
import type { ReactNode } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { BFF_PREFIX } from '../api/browser.ts';
import type { DiscoverMessages } from './messages.ts';
import { shortId } from './scope.ts';
import { workTypeOf } from './state.ts';
import type { WorkCover, WorkName } from './types.ts';

// Tints for covers without an image. Text-safe tones only: the logo red never
// sits behind text (docs/development/design-system.md).
const tints = ['bg-primary/10 text-primary', 'bg-info/10 text-info-foreground',
  'bg-success/10 text-success-foreground', 'bg-warning/10 text-warning-foreground',
  'bg-secondary text-secondary-foreground'] as const;

function tintOf(key: string): string {
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return tints[hash % tints.length]!;
}

/**
 * A Work's cover, or a tinted stand-in with its title's first letter. Image
 * URLs are Main paths, fetched through the BFF; `avatarQuery` carries the
 * acting Agent Main requires when the session sends a token.
 */
export function Cover({ cover, title, fallbackKey, avatarQuery = '', className }: {
  cover: WorkCover | null; title: string; fallbackKey: string; avatarQuery?: string; className?: string;
}) {
  const frame = cn('aspect-[2/3] w-full overflow-hidden rounded-xl border border-border/60', className);
  if (cover?.kind === 'image') {
    return <img src={`${BFF_PREFIX}${cover.url}${avatarQuery}`} alt="" width={cover.width} height={cover.height}
      loading="lazy" decoding="async" className={cn(frame, 'h-auto bg-muted object-cover')} />;
  }
  const initial = title.match(/[\p{L}\p{N}]/u)?.[0] ?? '·';
  return <div aria-hidden="true" className={cn(frame, 'grid place-items-center', tintOf(cover?.key ?? fallbackKey))}>
    <span className="font-work-title text-4xl">{initial}</span>
  </div>;
}

/**
 * A mean rating in the scope and Context it came from; the card never implies a
 * wider population. `own` is Mine: the reader's single standing rating.
 */
export interface CardRating { mean: number; count: number; max: number; own?: boolean }

export interface WorkCardProps {
  work: string;
  title: WorkName | null;
  cover: WorkCover | null;
  types: readonly string[];
  href: string;
  /** Names the population a rating came from, in words. */
  scopeLabel: string;
  rating?: CardRating | null;
  /** `tile` stands in a shelf; `row` lists a search result with room for its reasons. */
  layout?: 'tile' | 'row';
  avatarQuery?: string;
  /** Why the Work is here: match reasons and classification. */
  children?: ReactNode;
  locale: UiLocale;
  messages: DiscoverMessages;
  headingLevel?: 2 | 3;
}

/** One Work in a shelf or result list. The whole card opens the Work page. */
export function WorkCard({ work, title, cover, types, href, scopeLabel, rating, layout = 'tile', avatarQuery,
  children, locale, messages, headingLevel = 3 }: WorkCardProps) {
  const t = materializeData(messages, { locale });
  const Heading = `h${headingLevel}` as const;
  const name = title?.value ?? t.untitled({ id: shortId(work) });
  const decimal = new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const kinds = types.map(workTypeOf).filter(kind => kind !== null);
  const row = layout === 'row';
  return <article className={cn('group relative flex min-w-0 rounded-2xl bg-card text-card-foreground',
    'border border-border/60 shadow-(--aura-shadow-card) transition-shadow hover:border-primary/40',
    row ? 'flex-row gap-4 p-4 sm:gap-5' : 'h-full flex-col gap-3 p-3')}>
    <Cover cover={cover} title={name} fallbackKey={work} avatarQuery={avatarQuery}
      className={row ? 'w-18 shrink-0 self-start sm:w-22' : undefined} />
    <div className={cn('flex min-w-0 flex-1 flex-col', row ? 'gap-2' : 'gap-2 px-1 pb-1')}>
      <Heading lang={title?.language} dir={title?.direction}
        className={cn('font-semibold font-work-title',
          row ? 'text-lg/snug sm:text-xl/snug' : 'line-clamp-3 text-base/snug')}>
        <Link href={href} className="wrap-anywhere outline-none after:absolute after:inset-0 after:rounded-2xl
          hover:text-primary focus-visible:after:ring-2 focus-visible:after:ring-ring">{name}</Link>
      </Heading>
      {title?.basis === 'fallback' ? <p className="sr-only">{t.fallbackTitle}</p> : null}
      {kinds.length || rating ? <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm">
        {kinds.map(kind => <Badge key={kind} variant="outline">{t[`${kind}Type`]}</Badge>)}
        {rating ? <p className="flex basis-full flex-wrap items-center gap-x-2 text-muted-foreground">
          <span className="sr-only">{rating.own
            ? t.ownRating({ value: decimal.format(rating.mean), max: String(rating.max) })
            : t.ratingLabel({ mean: decimal.format(rating.mean), max: String(rating.max),
              count: String(rating.count), scope: scopeLabel })}</span>
          <span aria-hidden="true"
            className="inline-flex items-center gap-1 whitespace-nowrap font-medium text-foreground">
            <StarIcon className="size-3.5 fill-current text-warning" />
            {t.ratingSummary({ mean: decimal.format(rating.mean), max: String(rating.max) })}</span>
          {rating.own ? null
            : <span aria-hidden="true" className="whitespace-nowrap">{t.ratingCount(rating.count)}</span>}
        </p> : null}
      </div> : null}
      {children ? <div className="relative z-10 text-sm">{children}</div> : null}
    </div>
  </article>;
}
