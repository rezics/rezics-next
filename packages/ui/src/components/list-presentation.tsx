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
import { ContentItem } from './content-item.tsx';
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
