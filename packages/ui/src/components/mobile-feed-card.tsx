import type { ReactNode } from 'react';
import { Heart, MessageCircle, Share2 } from 'lucide-react';
import { cn } from '../utils';

export type MobileFeedCardAction = { label: string; count?: string; pressed?: boolean; onClick(): void };
export type MobileFeedCardProps = {
  community: { name: string; href: string; avatar?: ReactNode };
  age: ReactNode;
  /** Already localized, native figures from the caller; absent figures stay absent. */
  metadata?: ReactNode;
  title: ReactNode;
  href: string;
  media?: ReactNode;
  reaction?: MobileFeedCardAction;
  comments?: MobileFeedCardAction;
  share?: Omit<MobileFeedCardAction, 'count' | 'pressed'>;
  className?: string;
};
/** Post/media composition. Catalogue portraits retain their own list-row presentation. */
export function MobileFeedCard({
  community,
  age,
  metadata,
  title,
  href,
  media,
  reaction,
  comments,
  share,
  className,
}: MobileFeedCardProps) {
  const actionClass =
    'inline-flex min-h-11 items-center gap-2 rounded-full px-3 text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring';
  return (
    <article className={cn('min-w-0 space-y-3 border-b border-border/60 py-4', className)}>
      <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <a
          href={community.href}
          className="flex min-h-9 min-w-0 items-center gap-2 rounded-lg font-medium text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          {community.avatar ? (
            <span className="size-7 shrink-0 overflow-hidden rounded-full">{community.avatar}</span>
          ) : null}
          <span className="truncate">{community.name}</span>
        </a>
        <span className="shrink-0">· {age}</span>
        {metadata ? <span className="ms-auto truncate">{metadata}</span> : null}
      </div>
      <h2 className="text-base font-semibold leading-snug">
        <a href={href} className="rounded-md focus-visible:outline-2 focus-visible:outline-ring">
          {title}
        </a>
      </h2>
      {media ? (
        <div className="w-full overflow-hidden rounded-2xl [&_img]:h-auto [&_img]:w-full [&_video]:w-full">{media}</div>
      ) : null}
      <div className="flex items-center gap-1">
        {reaction ? (
          <button
            type="button"
            className={actionClass}
            aria-label={reaction.label}
            aria-pressed={reaction.pressed}
            onClick={reaction.onClick}
          >
            <Heart aria-hidden="true" className="size-4" />
            {reaction.count ?? reaction.label}
          </button>
        ) : null}
        {comments ? (
          <button type="button" className={actionClass} aria-label={comments.label} onClick={comments.onClick}>
            <MessageCircle aria-hidden="true" className="size-4" />
            {comments.count ?? comments.label}
          </button>
        ) : null}
        {share ? (
          <button type="button" className={`${actionClass} ms-auto`} onClick={share.onClick}>
            <Share2 aria-hidden="true" className="size-4" />
            {share.label}
          </button>
        ) : null}
      </div>
    </article>
  );
}
