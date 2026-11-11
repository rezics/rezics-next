import { useId, useLayoutEffect, useRef, type ReactNode } from 'react';
import {
  Cover,
  listPresentationForCover,
  type CoverProps,
  type CoverRatio,
  type CoverSubject,
  type CoverSummary,
  type ListPresentation,
} from './cover.tsx';
import { ContentItem } from './content-item.tsx';
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
          className={cn(
            'shrink-0 [&_button]:relative [&_button]:z-10',
            presentation?.imageAspect === 'landscape' ? 'w-32 sm:w-48' : 'w-[72px] sm:w-24',
          )}
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
  detailId: string;
  expanded: boolean;
  inspectLabel: string;
  onInspect: (opener: HTMLButtonElement) => void;
}

/**
 * Compact subject reading in either layout. Shadcn has no subject reading composition.
 * Detailed evidence belongs in MemberReadingDetail; arbitrary tile content stays outside the CoverCard action row.
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
  detailId,
  expanded,
  inspectLabel,
  onInspect,
}: MemberReadingItemProps) {
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
    <ContentItem
      {...identity}
      {...(href ? { href } : {})}
      title={title}
      {...(titleLang ? { titleLang } : {})}
      titleDataSlot="member-list-row-title"
      className="max-w-4xl [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:max-h-48"
      visual={
        cover ? (
          <div
            data-slot="member-list-row-cover"
            className={cn(
              'shrink-0 [&_button]:relative [&_button]:z-10',
              presentation?.imageAspect === 'landscape' ? 'w-32 sm:w-48' : 'w-[72px] sm:w-24',
            )}
          >
            <Cover {...cover} size="fill" decorative />
          </div>
        ) : undefined
      }
      metadata={<div className="line-clamp-4 min-w-0 w-full space-y-1">{metadata}</div>}
      preview={
        <p data-slot="collection-member-position" className="line-clamp-1 text-xs text-muted-foreground">
          {position}
        </p>
      }
      actions={opener}
    />
  );
}

/** One explicitly opened reading region, shared by rows and tiles, without an outlined content card. */
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
  const region = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    region.current?.focus();
    region.current?.scrollIntoView?.({ block: 'nearest' });
    // Retirement deliberately has no focus cleanup: the caller owns the next reading.
  }, []);
  function close() {
    onClose();
    opener.focus({ preventScroll: true });
  }
  return (
    <section
      ref={region}
      id={id}
      tabIndex={-1}
      aria-labelledby={titleId}
      data-slot="member-reading-detail"
      className="max-w-4xl min-w-0 space-y-5 border-t border-border pt-5 [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
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
