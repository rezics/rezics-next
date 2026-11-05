import type { ReactNode } from 'react';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { followCountsSearch, type FollowCountTarget } from './private-follow-counts';

export function privateFollowCountsHref(target: FollowCountTarget, locale = getLocale()): string | null {
  if (followCountsSearch(target).invalidContext) return null;
  const query = new URLSearchParams({ targetType: target.targetType, targetId: target.targetId });
  return `/${encodeURIComponent(locale)}/library/follow-counts?${query}`;
}

/** Owner menus pass the identity from their current resource read. Offering this link grants no count access. */
export function PrivateFollowCountsLink({
  target,
  children,
  className,
}: {
  target: FollowCountTarget;
  children?: ReactNode;
  className?: string;
}) {
  const href = privateFollowCountsHref(target);
  return href ? (
    <a href={href} className={className}>
      {children ?? m.library_follow_counts_heading()}
    </a>
  ) : null;
}
