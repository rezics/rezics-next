import type { ReactNode } from 'react';
import { ContentItem } from '@rezics/ui/content-item';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import { SubjectCover } from '../subject-row';
import type { FollowingRow } from './presentation';
import { followingDestinationClick, type FollowingReturnFrontier } from './return-context';

/** Presentation only: the page retains the single removal owner and selected-read lifetime. */
export function FollowingReadingRow({
  row,
  selected,
  suspended,
  disabled,
  canReadCollection,
  current,
  frontier,
  inspect,
  controls,
}: {
  row: FollowingRow;
  selected: boolean;
  suspended: boolean;
  disabled: boolean;
  canReadCollection: boolean;
  current: () => boolean;
  frontier: FollowingReturnFrontier | null;
  inspect: (trigger: HTMLButtonElement) => void;
  controls: ReactNode;
}) {
  const { follow, title, targetKind, kind, destination } = row;
  const collectionWithdrawn = destination?.kind === 'collection' && !canReadCollection;
  const href = suspended || collectionWithdrawn ? undefined : destination?.href;
  const admission = suspended
    ? null
    : collectionWithdrawn
      ? m.following_reading_collection_withdrawn()
      : !follow.target
        ? m.following_reading_identity_unavailable()
        : !href
          ? m.following_reading_no_destination()
          : null;

  return (
    <ContentItem
      data-follow-target={follow.targetId}
      data-follow-target-type={follow.targetType}
      data-following-selected={selected || undefined}
      className={`px-3 sm:px-4 ${selected ? 'bg-accent/40' : ''}`}
      title={title.text}
      {...(title.lang ? { titleLang: title.lang } : {})}
      headingLevel={3}
      {...(href ? { href } : {})}
      onClickCapture={(event) => {
        if (event.target instanceof Element && event.target.closest('a'))
          followingDestinationClick(event, current, frontier);
      }}
      visual={follow.target?.cover ? <SubjectCover subject={follow.target} ratio="2:3" /> : undefined}
      metadata={
        <>
          <span className="font-medium text-foreground/80">{targetKind}</span>
          {kind !== targetKind ? <span>{kind}</span> : null}
        </>
      }
      preview={
        admission ? (
          <p data-following-admission="" className="text-muted-foreground">
            {admission}
          </p>
        ) : undefined
      }
      actions={
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {controls}
          <Button
            data-following-inspect=""
            className="min-h-11"
            variant={selected ? 'secondary' : 'outline'}
            disabled={disabled}
            aria-disabled={suspended || undefined}
            aria-expanded={selected}
            aria-controls={selected ? 'following-inspection' : undefined}
            aria-label={m.following_reading_inspect_target({ title: title.text })}
            onClick={(event) => inspect(event.currentTarget)}
          >
            {m.following_reading_inspect()}
          </Button>
        </div>
      }
      trailing={
        href ? (
          <a
            href={href}
            aria-label={m.following_reading_open({ title: title.text })}
            className={buttonVariants({ variant: 'outline', className: 'min-h-11' })}
          >
            {m.following_reading_open_action()}
          </a>
        ) : undefined
      }
    />
  );
}
