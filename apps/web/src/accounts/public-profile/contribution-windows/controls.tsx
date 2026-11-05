import { Link } from '@tanstack/react-router';
import { useLayoutEffect } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { m } from '../../../paraglide/messages.js';
import { useContributionWindowRoute } from './route';
import {
  beginContributionWindowMove,
  consumeContributionWindowFocus,
  contributionWindowSnapshot,
  retryContributionWindow,
  type ContributionCoordinate,
  type ContributionWindowAction,
  type ContributionWindowOutcome,
  type ContributionWindowOwner,
} from './state';

const controlClass =
  'inline-flex min-h-11 items-center justify-center rounded-md border border-border px-3 py-2 text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

function rawQueryWithoutCursor(search: string): string[] {
  const raw = search.startsWith('?') ? search.slice(1) : search;
  if (!raw) return [];
  return raw.split('&').filter((part) => !new URLSearchParams(part).has('cursor'));
}

export function contributionWindowHref(input: {
  pathname: string;
  search: string;
  hash: string;
  cursor: ContributionCoordinate;
}): string {
  const retained = rawQueryWithoutCursor(input.search);
  if (input.cursor !== null) retained.push(`cursor=${encodeURIComponent(input.cursor)}`);
  return `${input.pathname}${retained.length ? `?${retained.join('&')}` : ''}${input.hash}`;
}

function linkAction(
  action: Exclude<ContributionWindowAction, 'retry'>,
  owner: ContributionWindowOwner,
  cursor: ContributionCoordinate,
  currentHref: string,
  target: ContributionCoordinate,
  targetHref: string,
  source: HTMLElement,
  event: ReactMouseEvent<HTMLAnchorElement>,
) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey)
    return;
  beginContributionWindowMove({
    owner,
    cursor,
    currentHref,
    target,
    targetHref,
    action,
    event,
    source,
  });
}

export function ContributionWindowControls({
  owner,
  cursor,
  next,
  outcome,
  failure,
  title,
  region,
}: {
  owner: ContributionWindowOwner;
  cursor: ContributionCoordinate;
  next: string | null;
  outcome: ContributionWindowOutcome;
  failure?: 'denied' | 'preparing' | 'unavailable' | 'invalid-cursor';
  title: string;
  region: { current: HTMLElement | null };
}) {
  const route = useContributionWindowRoute();
  const href = route ? `${route.pathname}${route.search}${route.hash}` : '';
  const destination = (target: ContributionCoordinate) =>
    route ? contributionWindowHref({ ...route, cursor: target }) : '';
  const snapshot =
    route && owner.published
      ? contributionWindowSnapshot({ owner, cursor, href, outcome })
      : { predecessors: [], current: cursor, pending: null, focusReady: false };
  const hasPrevious = snapshot.predecessors.length > 0;
  const previous = hasPrevious ? snapshot.predecessors[snapshot.predecessors.length - 1]! : undefined;
  const firstAvailable =
    snapshot.current !== null || cursor !== null || (snapshot.pending !== null && snapshot.pending.target !== null);
  const retryAvailable = failure !== 'invalid-cursor' && (failure !== undefined || snapshot.pending?.failed === true);
  const showNavigation =
    hasPrevious || firstAvailable || (outcome === 'admitted' && next !== null) || retryAvailable;

  useLayoutEffect(() => {
    if (!snapshot.focusReady || !route) return;
    const target = consumeContributionWindowFocus({ owner, cursor, href, region: region.current });
    if (target) return;
  }, [cursor, href, owner, region, snapshot.focusReady]);

  if (!route || !owner.published || failure === 'denied' || !showNavigation) return null;

  const currentOptions = { locale: owner.locale as never };
  const firstHref = destination(null);
  const previousHref = previous === undefined ? undefined : destination(previous);
  const nextHref = next === null ? undefined : destination(next);

  return (
    <nav aria-label={title} className="mt-4 flex flex-wrap gap-2" data-slot="contribution-window-navigation">
      {previous !== undefined && previousHref && (
        <Link
          data-slot="previous-page"
          data-window-action="previous"
          href={previousHref}
          className={controlClass}
          onClick={(event) =>
            linkAction('previous', owner, cursor, href, previous, previousHref, event.currentTarget, event)
          }
        >
          {m.public_account_previous_page({}, currentOptions)}
        </Link>
      )}
      {firstAvailable && (
        <Link
          data-slot="first-page"
          data-window-action="first"
          href={firstHref}
          className={controlClass}
          onClick={(event) => linkAction('first', owner, cursor, href, null, firstHref, event.currentTarget, event)}
        >
          {m.public_account_start_again({}, currentOptions)}
        </Link>
      )}
      {outcome === 'admitted' && next !== null && nextHref && (
        <Link
          data-slot="continuation"
          data-window-action="next"
          rel="next"
          href={nextHref}
          className={controlClass}
          onClick={(event) => linkAction('next', owner, cursor, href, next, nextHref, event.currentTarget, event)}
        >
          {m.threads_next_page({}, currentOptions)}
        </Link>
      )}
      {retryAvailable && (
        <button
          type="button"
          data-slot="retry"
          className={controlClass}
          onClick={() => {
            retryContributionWindow({ owner, cursor, href });
            route.retry();
          }}
        >
          {m.public_account_retry({}, currentOptions)}
        </button>
      )}
    </nav>
  );
}
