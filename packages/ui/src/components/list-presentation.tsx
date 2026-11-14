import { useId, type ReactNode } from 'react';
import {
  Cover,
  listPresentationForCover,
  type CoverProps,
  type CoverRatio,
  type CoverSubject,
  type CoverSummary,
  type ListPresentation,
} from './cover.tsx';
import { ContentItem, ContentItemHeading } from './content-item.tsx';
import { ListRow, ListRowControl, ListRowLink } from './list-row.tsx';
import { CoverCard, type CoverCardProps } from './cover-card.tsx';
import { Button } from '../shadcn/button.tsx';
import { cn } from '../utils.ts';

/** A member row keeps its actual Type, cover, title and bounded supplied details together. */
export function MemberListRow({
  href,
  subject,
  cover,
  src,
  title,
  titleLang,
  listPresentation,
  ratio,
  suitability,
  labels,
  storyOverlay = false,
  trailing,
  className,
  children,
}: {
  href: string;
  subject: CoverSubject;
  cover: CoverSummary | null;
  src: CoverProps['src'];
  title: string;
  titleLang?: string;
  /** A resolved release value when the current reader already has one. */
  listPresentation?: ListPresentation;
  /** Composition fallback for an unknown Type; never replaces a known member's presentation. */
  ratio?: CoverRatio;
  suitability?: CoverProps['suitability'];
  labels?: CoverProps['labels'];
  storyOverlay?: boolean;
  trailing?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  const presentation = listPresentationForCover(subject, listPresentation);
  const hasChildren = children !== null && children !== undefined && typeof children !== 'boolean';
  return (
    <ContentItem
      href={href}
      title={title}
      {...(titleLang ? { titleLang } : {})}
      titleDataSlot="member-list-row-title"
      forceOverlay={storyOverlay}
      className={className}
      visual={
        <div
          data-slot="member-list-row-cover"
          className={cn('shrink-0', presentation?.imageAspect === 'landscape' ? 'w-32 sm:w-48' : 'w-[72px] sm:w-24')}
        >
          <Cover
            subject={subject}
            cover={cover}
            size="fill"
            src={src}
            decorative
            {...(presentation ? { listPresentation: presentation } : {})}
            {...(ratio ? { ratio } : {})}
            {...(suitability ? { suitability } : {})}
            {...(labels ? { labels } : {})}
          />
        </div>
      }
      {...(hasChildren ? { metadata: <div className="w-full space-y-1">{children}</div> } : {})}
      {...(trailing != null ? { trailing } : {})}
    />
  );
}

export interface MemberReadingItemProps {
  layout: 'list' | 'grid';
  href?: string;
  title: string;
  titleLang?: string;
  cover?: CoverCardProps['cover'];
  /** Exact native occurrence identity. Omit for projections without one. */
  occurrenceId?: string;
  occurrenceLabel: string;
  position: ReactNode;
  metadata: ReactNode;
  /** Evidence shown on grid items; the list uses a bounded summary and keeps this in the Inspect detail. */
  evidence?: ReactNode;
  /** The one selected occurrence's supplied detail; rendered after its opener in normal flow. */
  detail?: ReactNode;
  detailId: string;
  expanded: boolean;
  inspectLabel: string;
  onInspect: (opener: HTMLButtonElement) => void;
  /** Escape at the expanded opener closes its local detail without moving focus. */
  onClose?: () => void;
}

/**
 * Compact subject reading in either layout. Shadcn has no subject reading composition.
 * The selected detail follows its opener inside this occurrence, outside the compact summary and card action row.
 */
export function MemberReadingItem({
  layout,
  href,
  title,
  titleLang,
  cover,
  occurrenceId,
  occurrenceLabel,
  position,
  metadata,
  evidence,
  detail,
  detailId,
  expanded,
  inspectLabel,
  onInspect,
  onClose,
}: MemberReadingItemProps) {
  const titleId = useId();
  const opener = (
    <Button
      type="button"
      variant="link"
      aria-label={`${inspectLabel}: ${occurrenceLabel}`}
      aria-expanded={expanded}
      aria-controls={detailId}
      data-collection-detail-opener
      className="h-auto min-h-11 min-w-11 max-w-full justify-start whitespace-normal rounded-sm px-0 py-2 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      onClick={(event) => onInspect(event.currentTarget)}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && expanded && onClose && !event.defaultPrevented) {
          event.preventDefault();
          onClose();
        }
      }}
    >
      {inspectLabel}
    </Button>
  );
  const identity = {
    id: occurrenceId ? `collection-member-${occurrenceId}` : undefined,
    tabIndex: -1,
    'aria-label': occurrenceLabel,
    'data-collection-member-id': occurrenceId,
    'data-collection-occurrence-availability': cover ? 'available' : 'unavailable',
  };
  if (layout === 'grid') {
    // Keep every grid detail in the card's measured flow; siblings after a height-full card can overlap More.
    const gridDetails = (
      <div className="min-w-0 space-y-2 text-left">
        {metadata}
        <p data-slot="collection-member-position" className="text-xs text-muted-foreground">
          {position}
        </p>
        {evidence}
        {opener}
        {detail}
      </div>
    );
    return (
      <div
        {...identity}
        role="listitem"
        data-slot="collection-member-card"
        className="min-w-0 space-y-2 [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        {cover ? (
          <CoverCard
            {...(href ? { href } : {})}
            title={title}
            {...(titleLang ? { titleLang } : {})}
            cover={cover}
            meta={gridDetails}
          />
        ) : (
          <div className="min-w-0 space-y-2 py-3 [overflow-wrap:anywhere]">
            <h3 className="text-sm font-semibold">{title}</h3>
            {gridDetails}
          </div>
        )}
      </div>
    );
  }
  const presentation = cover && listPresentationForCover(cover.subject, cover.listPresentation);
  return (
    <ListRow
      {...identity}
      className="@container/content-item max-w-4xl min-w-0 py-3 [overflow-wrap:anywhere] sm:py-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <div data-slot="member-reading-summary" className="flex min-w-0 items-start gap-3 sm:gap-4">
        {href && (
          <ListRowLink href={href} lang={titleLang} aria-labelledby={titleId}>
            {title}
          </ListRowLink>
        )}
        {cover && (
          <ListRowControl data-content-item-slot="visual" className="shrink-0">
            <div
              data-slot="member-list-row-cover"
              className={cn('shrink-0', presentation?.imageAspect === 'landscape' ? 'w-32 sm:w-48' : 'w-[72px] sm:w-24')}
            >
              <Cover {...cover} size="fill" decorative />
            </div>
          </ListRowControl>
        )}
        <div className="min-w-0 flex-1 @min-[40rem]/content-item:grid @min-[40rem]/content-item:grid-cols-[minmax(0,1fr)_fit-content(40%)] @min-[40rem]/content-item:items-start @min-[40rem]/content-item:gap-x-4">
          <div className="min-w-0">
            <ContentItemHeading
              id={titleId}
              lang={titleLang}
              data-slot="member-list-row-title"
              className="whitespace-normal text-[17px] leading-snug font-semibold wrap-anywhere sm:text-lg md:text-xl"
            >
              {title}
            </ContentItemHeading>
            <ListRowControl
              data-content-item-slot="metadata"
              className="mt-2 min-w-0 text-[13px] leading-snug text-muted-foreground sm:text-sm"
            >
              <div className="line-clamp-4 min-w-0 w-full space-y-1">{metadata}</div>
            </ListRowControl>
            <p data-slot="collection-member-position" className="mt-2 line-clamp-1 text-xs text-muted-foreground">
              {position}
            </p>
          </div>
          <ListRowControl
            data-content-item-slot="actions"
            className="mt-3 flex min-h-11 min-w-0 flex-wrap items-center gap-2 @min-[40rem]/content-item:col-start-2 @min-[40rem]/content-item:row-start-1 @min-[40rem]/content-item:mt-0 @min-[40rem]/content-item:justify-end"
          >
            {opener}
          </ListRowControl>
        </div>
      </div>
      {detail != null && <ListRowControl className="mt-5 min-w-0">{detail}</ListRowControl>}
    </ListRow>
  );
}

/** A local reading region: opening preserves focus and viewport; explicit close returns to its opener. */
export function MemberReadingDetail({
  id,
  title,
  closeLabel,
  opener,
  onClose,
  children,
}: {
  id: string;
  title: string;
  closeLabel: string;
  opener: HTMLButtonElement;
  onClose: () => void;
  children: ReactNode;
}) {
  const titleId = useId();
  function close() {
    onClose();
    opener.focus({ preventScroll: true });
  }
  return (
    <section
      id={id}
      tabIndex={-1}
      aria-labelledby={titleId}
      data-slot="member-reading-detail"
      className="max-w-4xl min-w-0 space-y-5 border-t border-border pt-5 text-left text-sm leading-normal font-normal text-foreground [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented) {
          event.preventDefault();
          close();
        }
      }}
    >
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <h3 id={titleId} className="min-w-0 text-lg font-semibold">
          {title}
        </h3>
        <Button
          type="button"
          variant="ghost"
          className="min-h-11 min-w-11 max-w-full whitespace-normal"
          onClick={close}
        >
          {closeLabel}
        </Button>
      </div>
      {children}
    </section>
  );
}
