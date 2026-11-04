import { Avatar, AvatarFallback, AvatarImage } from '@rezics/ui/shadcn/avatar';
import type { ReactNode } from 'react';
import { initials } from '../threads/initials';
import { m } from '../paraglide/messages.js';
import type { ResolvedInboxPage } from './inbox-read';

type Actor = NonNullable<ResolvedInboxPage['items'][number]['actor']>;

export type InboxNoticeActorInput = {
  actor?: Actor;
  actorId?: string | null;
  actorName?: string;
  kind?: string;
  reportId?: string | null;
  hideLegacy?: boolean;
};

export type InboxNoticeActorPresentation = {
  label: string;
  actorId: string | null;
  avatarUrl: string | null;
  initials: string;
  handle: string | null;
  hasAvatar: boolean;
  unavailable: boolean;
};

/** Resolve native and retained fixture actor states once for both Inbox views. */
export function inboxNoticeActorPresentation(input: InboxNoticeActorInput): InboxNoticeActorPresentation {
  const actor = input.actor;
  const hiddenLegacy = input.hideLegacy ?? false;
  const actorId =
    actor?.state === 'available' ? actor.accountId : actor || hiddenLegacy ? null : (input.actorId ?? null);
  const label =
    actor?.state === 'available'
      ? actor.displayName.trim() || m.inbox_actor_unknown()
      : actor?.state === 'system' || (!actor && (input.reportId || input.kind === 'moderation_decision'))
        ? m.inbox_actor_moderation()
        : actor?.state === 'withheld' || hiddenLegacy
          ? m.inbox_actor_unknown()
          : input.actorName || m.inbox_actor_unknown();
  const available = actor?.state === 'available';
  const identity = available ? actor.displayName.trim() || label : input.actorName || label;
  const initialSource = available || actor ? identity : (actorId ?? identity);
  return {
    label,
    actorId,
    avatarUrl: available ? actor.avatarUrl : null,
    initials: initials(initialSource),
    handle: available ? actor.handle : null,
    hasAvatar: available || (!actor && !hiddenLegacy && actorId !== null),
    unavailable: actor ? !available : hiddenLegacy,
  };
}

export function InboxNoticeActorVisual({
  presentation,
  size,
  avatarClassName,
  fallbackClassName,
  fallback,
  dataIconKind,
}: {
  presentation: InboxNoticeActorPresentation;
  size: 'sm' | 'default';
  avatarClassName?: string;
  fallbackClassName?: string;
  fallback?: ReactNode;
  dataIconKind?: string;
}) {
  if (presentation.hasAvatar)
    return (
      <Avatar aria-hidden="true" size={size} className={avatarClassName}>
        {presentation.avatarUrl ? <AvatarImage src={presentation.avatarUrl} alt="" /> : null}
        <AvatarFallback>{presentation.initials}</AvatarFallback>
      </Avatar>
    );
  return fallback ? (
    <span aria-hidden="true" className={fallbackClassName}>
      {dataIconKind ? <span data-icon-kind={dataIconKind}>{fallback}</span> : fallback}
    </span>
  ) : null;
}
