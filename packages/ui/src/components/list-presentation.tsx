import type { ReactNode } from 'react';
import {
  Cover,
  listPresentationForCover,
  type CoverProps,
  type CoverSubject,
  type CoverSummary,
  type ListPresentation,
} from './cover.tsx';
import { ListRow, ListRowLink } from './list-row.tsx';
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
  suitability?: CoverProps['suitability'];
  labels?: CoverProps['labels'];
  storyOverlay?: boolean;
  trailing?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  const presentation = listPresentationForCover(subject, listPresentation);
  return (
    <ListRow
      forceOverlay={storyOverlay}
      className={cn('flex min-w-0 items-start gap-4 py-2', className)}
    >
      <ListRowLink href={href} lang={titleLang}>
        {title}
      </ListRowLink>
      <div data-slot="member-list-row-cover" className="w-[72px] shrink-0 sm:w-24">
        <Cover
          subject={subject}
          cover={cover}
          size="fill"
          src={src}
          decorative
          {...(presentation ? { listPresentation: presentation } : {})}
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
        {trailing}
      </div>
    </ListRow>
  );
}
