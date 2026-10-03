import { WorkCover, type WorkCoverProps } from '@rezics/ui/work-cover';
import { cn } from '@rezics/ui/utils';
import { type CoverWork, coverProps } from './work.ts';

/**
 * A Work's one cover, as every surface draws it: home, Discover, search,
 * Library, profiles, Zones, Manage, the Work page and Studio. Build `work`
 * from any read that names the Work's id, types (`coverKindOf`), title and
 * credited authors; the same Work then looks the same everywhere.
 */
export function CatalogueCover({ work, avatarQuery, className, ...props }: { work: CoverWork; avatarQuery?: string }
  & Pick<WorkCoverProps, 'size' | 'loading' | 'alt' | 'className' | 'style' | 'revealable'>) {
  return <WorkCover {...coverProps(work, avatarQuery)} {...props} className={cn(
    // Imported art fits the same kind-sized box as generated covers, without cropping its title.
    '[&_[data-slot=media-image]]:size-full [&_[data-slot=media-image]]:bg-muted [&_[data-slot=media-image]]:object-contain',
    className,
  )} />;
}
