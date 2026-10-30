import type { ReactNode } from 'react';
import {
  Cover,
  listPresentationForCover,
  type CoverProps,
  type CoverRatio,
  type CoverSubject,
  type CoverSummary,
  type ListPresentation,
} from './cover.tsx';
import { ListRow, ListRowControl, ListRowLink } from './list-row.tsx';
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
  return (
    <ListRow forceOverlay={storyOverlay} className={cn('flex min-w-0 items-start gap-4 py-2', className)}>
      <ListRowLink href={href} lang={titleLang}>
        {title}
      </ListRowLink>
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
      <div className="flex min-w-0 flex-1 items-start justify-between gap-3">
        <div data-slot="item-content" className="min-w-0 space-y-1">
          <h2
            aria-hidden="true"
            data-slot="member-list-row-title"
            lang={titleLang}
            className="line-clamp-2 text-base leading-snug font-semibold"
          >
            {title}
          </h2>
          {children}
        </div>
        {trailing != null && <ListRowControl className="shrink-0">{trailing}</ListRowControl>}
      </div>
    </ListRow>
  );
}
