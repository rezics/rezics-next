'use client';

import type { ReactNode } from 'react';

import { useMediaImagePresentation } from '@rezics/ui/media-image';
import { WorkCover, type WorkCoverProps } from '@rezics/ui/work-cover';
import { cn } from '@rezics/ui/utils';
import type { UiLocale } from '../../i18n/define.ts';
import { CoverCreditMark } from '../rights-mark/rights-mark.tsx';
import { useOptionalShell } from '../shell/shell-provider.tsx';
import { type CoverWork, coverImage, coverProps } from './work.ts';

/** Keep this outside Work links and hidden image duplicates. */
function useCoverCredit(work: CoverWork, avatarQuery?: string) {
  const image = coverImage(work.cover, avatarQuery);
  const { metadata, presentation } = useMediaImagePresentation(image?.src, image ?? undefined);
  if (!image || presentation === 'unavailable' || presentation === 'rating-hidden') return null;
  // SSR can name the selected cover before its display-preference metadata resolves.
  return metadata === undefined ? image.coverCredit ?? null : metadata?.coverCredit ?? null;
}

export function CatalogueCoverCredit({ work, avatarQuery, locale, className, children }: {
  work: CoverWork; avatarQuery?: string; locale?: UiLocale; className?: string;
  /** A host can place the current credit in its own attribution region, only when there is credit to show. */
  children?: (credit: ReactNode) => ReactNode;
}) {
  const shell = useOptionalShell();
  const credit = useCoverCredit(work, avatarQuery);
  if (!credit) return null;
  const mark = <div className={cn('relative z-10 min-w-0', className)} onClick={event => event.stopPropagation()}
    onMouseDown={event => event.stopPropagation()}>
    <CoverCreditMark credit={credit} locale={locale ?? shell?.locale ?? 'en'} />
  </div>;
  return children ? children(mark) : mark;
}

/**
 * A Work's one cover, as every surface draws it: home, Discover, search,
 * Library, profiles, Zones, Manage, the Work page and Studio. Build `work`
 * from any read that names the Work's id, types (`coverKindOf`), title and
 * credited authors; the same Work then looks the same everywhere. This draws
 * only the image: consumers place CatalogueCoverCredit outside their controls.
 */
export function CatalogueCover({ work, avatarQuery, className, ...props }: {
  work: CoverWork; avatarQuery?: string;
}
  & Pick<WorkCoverProps, 'size' | 'loading' | 'alt' | 'className' | 'style' | 'revealable'>) {
  return <WorkCover {...coverProps(work, avatarQuery)} {...props} className={cn(
    // Imported art fits the same kind-sized box as generated covers, without cropping its title.
    '[&_[data-slot=media-image]]:size-full [&_[data-slot=media-image]]:bg-muted [&_[data-slot=media-image]]:object-contain',
    className,
  )} />;
}
