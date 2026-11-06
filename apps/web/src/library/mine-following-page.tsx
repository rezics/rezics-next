import type { FollowingKind } from './following-kind-navigation/address';
import {
  acceptFollowingWindow,
  emptyFollowingWindowHistory,
  reconcileFollowingAddress,
  reconcileFollowingAuthority,
  reconcileFollowingIdentity,
  sameFollowingWindow,
  seedFollowingWindow,
  stageFollowingWindow,
  type FollowingMovement,
  type FollowingWindow,
  type FollowingWindowHistory,
} from './following-kind-navigation/window-history';
import { Exposure, useOperation } from '../kernel/exposure';
import { ContentItem } from '@rezics/ui/content-item';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader } from '@rezics/ui/shadcn/empty';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { queryOptions, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { PageHeading } from '../shell/page-heading';
import type { MineFollowingPage } from './mine-following';
import { FollowTargetControl } from './follow-target-control';
import { personalRead } from '../kernel/query';
import {
  assertHistoryCurrent,
  useHistoryAddress,
  useHistoryCurrentOrigin,
  useHistoryReadOrigin,
  type HistoryOrigin,
} from './history-current-origin';
import { readMineFollowingForViewer, type MineFollowingRead } from './mine-following-actions';
import { PERSONAL_DIRECTORY_CURSOR_LIMITS, personalDirectoryAddress } from './personal-directory-address';
import type { FollowState } from './follow-records';

import { prepareFollowing } from './following-reading/presentation';
import { useFollowingSelection } from './following-reading/current-selection';
import { FollowingInspection, type FollowingSpaceReader } from './following-reading/inspection';
import { useFollowingReturn } from './following-reading/return';
import {
  clearFollowingReturn,
  followingDestinationClick,
  followingReturnFrontier,
  followingReturnMatchesWindow,
  followingReturnTrigger,
  readFollowingReturn,
} from './following-reading/return-context';
import { SubjectCover } from './subject-row';
import { createFollowIntent, type FollowIntentOwner } from './mine-following-intent';

type ReviewFollow = (targetId: string) => Promise<FollowState | null>;
type FollowingWindowIdentity = { source: object; subject: string; locale: string; authorityEpoch: number };
type FollowingWindowNavigation = {
  previous: FollowingWindow | null;
  busy: boolean;
  unsettledRemoval: boolean;
  focusId?: number;
  move: (target: FollowingWindow, movement: FollowingMovement, keyboard: boolean) => boolean;
  removalChanged: (targetId: string, unsettled: boolean) => void;
};
type FollowingDirectKindMovement = {
  from: FollowingWindow;
  fromVisit: number;
  target: FollowingWindow;
  targetVisit?: number;
  id: number;
  keyboard: boolean;
  subject: string;
  locale: string;
  authorityEpoch: number;
};

const retiredPage: MineFollowingPage = { signedIn: false, follows: [], next: null };

const followingOperations = ['follow.list'] as const;
const followingReadingOperations = ['follow.list', 'collection.get'] as const;

export const mineFollowingQuery = (
  subject: string,
  cursor: string | null,
  locale: string,
  origin?: HistoryOrigin & { key: string },
  kind: FollowingKind = 'all',
) =>
  queryOptions({
    ...personalRead,
    queryKey: ['mine-following', subject, 'follow.list', true, cursor, locale, kind, ...(origin ? [origin.key] : [])],
    queryFn: async ({ signal }) => {
      const current = origin?.isCurrent ?? (() => true);
      assertHistoryCurrent(current, signal);
      try {
        const result = await readMineFollowingForViewer({ data: { cursor: cursor ?? undefined, kind } });
        assertHistoryCurrent(current, signal);
        return result;
      } catch (error) {
        assertHistoryCurrent(current, signal);
        throw error;
      }
    },
    gcTime: 0,
    structuralSharing: false,
    staleTime: Infinity,
    refetchOnMount: true,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

function matches(
  read: MineFollowingRead,
  subject: string,
  cursor: string | null,
  locale: string,
  kind: FollowingKind = 'all',
): boolean {
  return (
    read.page.signedIn &&
    !read.page.addressInvalid &&
    read.subject === subject &&
    read.cursor === cursor &&
    read.locale === locale &&
    (read.kind ?? 'all') === kind
  );
}

/** Retained router data is a candidate, never authority for the browser's current viewer. */
export function CurrentViewerMineFollowingPage({
  initial,
  cursor,
  kind = 'all',
  invalidAddress = false,
}: {
  initial: MineFollowingRead;
  cursor?: string | undefined;
  invalidAddress?: boolean;
  kind?: FollowingKind;
}) {
  useOperation('follow.list');
  const locale = getLocale();
  const requestedAddress = personalDirectoryAddress(cursor, PERSONAL_DIRECTORY_CURSOR_LIMITS.following);
  const addressInvalid = invalidAddress || !requestedAddress.valid;
  const address = useHistoryAddress(null, requestedAddress.cursor ?? undefined, locale);
  const originAddress = JSON.stringify([address.key, kind, addressInvalid]);
  const origin = useHistoryCurrentOrigin(
    originAddress,
    followingOperations,
    initial.page.signedIn ? initial.subject : null,
  );
  const current = () => address.isCurrent() && origin.current(0);
  const options = mineFollowingQuery(
    origin.subject ?? '',
    address.cursor,
    locale,
    {
      lifetime: origin.boundary.lifetime,
      key: origin.lifetime(0),
      isCurrent: current,
    },
    kind,
  );
  const read = useQuery(
    {
      ...options,
      enabled:
        personalRead.enabled &&
        !addressInvalid &&
        origin.hydrated &&
        !!origin.subject &&
        origin.allowed[0] === true &&
        address.isCurrent(),
      ...(!addressInvalid &&
      origin.seed &&
      origin.subject &&
      matches(initial, origin.subject, address.cursor, locale, kind)
        ? { initialData: initial }
        : {}),
    },
    origin.client,
  );
  const readCurrent = useHistoryReadOrigin(
    origin.client,
    options.queryKey,
    (value) =>
      !!value && !!origin.subject && matches(value as MineFollowingRead, origin.subject, address.cursor, locale, kind),
  );
  const previousLoader = useRef(initial);
  useEffect(() => {
    if (previousLoader.current === initial) return;
    previousLoader.current = initial;
    if (current()) void read.refetch();
  }, [initial, read.refetch, origin.lifetime(0)]);
  const page =
    !addressInvalid &&
    read.data &&
    origin.subject &&
    origin.retained[0] === true &&
    address.isCurrent() &&
    matches(read.data, origin.subject, address.cursor, locale, kind)
      ? read.data.page
      : retiredPage;
  const rowOriginCurrent = useRef<() => boolean>(() => false);
  rowOriginCurrent.current = () => current() && readCurrent();
  const rowOrigin: HistoryOrigin = {
    lifetime: origin.boundary.lifetime,
    isCurrent: () => rowOriginCurrent.current(),
  };
  const retryState = origin.client.getQueryState(options.queryKey);
  const status =
    !addressInvalid && origin.subject && origin.allowed[0] === true && (read.isError || !page.signedIn)
      ? read.isError || read.data
        ? 'unavailable'
        : 'preparing'
      : undefined;
  const [, setNavigationRevision] = useState(0);
  const navigation = useRef<FollowingWindowHistory>(emptyFollowingWindowHistory());
  const sourceTokens = useRef(new WeakMap<object, object>()).current;
  const authorityEpoch = origin.epoch(0)!;
  const nextMovementId = useRef(0);
  const unsettledRemovals = useRef(new Set<string>());
  const directKindMovement = useRef<FollowingDirectKindMovement | null>(null);
  const routeVisit = useRef({ key: address.key, id: 0 });
  if (routeVisit.current.key !== address.key) routeVisit.current = { key: address.key, id: routeVisit.current.id + 1 };
  const addressVisit = routeVisit.current.id;
  const coordinate: FollowingWindow = { cursor: address.cursor, kind };
  const sourceIdentity = (value: MineFollowingRead): FollowingWindowIdentity => {
    let source = sourceTokens.get(value);
    if (!source) {
      source = {};
      sourceTokens.set(value, source);
    }
    return { source, subject: value.subject!, locale, authorityEpoch };
  };
  const candidate =
    !addressInvalid &&
    !!origin.subject &&
    read.data &&
    !read.data.page.forbidden &&
    !read.data.page.kindUnavailable &&
    matches(read.data, origin.subject, address.cursor, locale, kind)
      ? sourceIdentity(read.data)
      : null;
  let currentNavigation = navigation.current;
  if (!origin.subject || !origin.allowed[0]) {
    directKindMovement.current = null;
    currentNavigation = emptyFollowingWindowHistory();
    unsettledRemovals.current.clear();
  } else {
    currentNavigation = reconcileFollowingAuthority(currentNavigation, origin.subject, locale, authorityEpoch);
    let direct = directKindMovement.current;
    if (
      addressInvalid ||
      read.data?.page.forbidden ||
      read.data?.page.kindUnavailable ||
      read.data?.page.addressInvalid ||
      (direct &&
        (direct.subject !== origin.subject || direct.locale !== locale || direct.authorityEpoch !== authorityEpoch))
    ) {
      direct = null;
    } else if (direct) {
      if (sameFollowingWindow(coordinate, direct.target)) {
        if (direct.targetVisit === addressVisit) {
          // Keep the exact staged kind visit while its reader retries.
        } else if (direct.targetVisit === undefined && addressVisit !== direct.fromVisit) {
          direct = { ...direct, targetVisit: addressVisit };
        } else direct = null;
      } else if (!sameFollowingWindow(coordinate, direct.from) || addressVisit !== direct.fromVisit) direct = null;
    }
    directKindMovement.current = direct;
    if (!direct) {
      currentNavigation = addressInvalid
        ? emptyFollowingWindowHistory()
        : reconcileFollowingAddress(currentNavigation, coordinate, addressVisit);
      if (candidate) currentNavigation = reconcileFollowingIdentity(currentNavigation, coordinate, candidate);
    }
    if (read.data?.page.forbidden || read.data?.page.kindUnavailable || read.data?.page.addressInvalid) {
      directKindMovement.current = null;
      currentNavigation = emptyFollowingWindowHistory();
    }
  }
  if (currentNavigation !== navigation.current) navigation.current = currentNavigation;
  const currentIdentity = useRef<() => FollowingWindowIdentity | null>(() => null);
  currentIdentity.current = () => {
    if (
      directKindMovement.current ||
      !candidate ||
      addressInvalid ||
      !address.isCurrent() ||
      !origin.current(0) ||
      !readCurrent() ||
      origin.client.getQueryData(options.queryKey) !== read.data
    )
      return null;
    return candidate;
  };
  useLayoutEffect(() => {
    if (
      !candidate ||
      addressInvalid ||
      !address.isCurrent() ||
      !origin.current(0) ||
      !readCurrent() ||
      origin.client.getQueryData(options.queryKey) !== read.data
    )
      return;
    const direct = directKindMovement.current;
    const directTarget = direct && sameFollowingWindow(coordinate, direct.target);
    const seeded = directTarget
      ? seedFollowingWindow(emptyFollowingWindowHistory(), coordinate, addressVisit, candidate)
      : navigation.current.staged
        ? acceptFollowingWindow(navigation.current, coordinate, addressVisit, candidate)
        : seedFollowingWindow(navigation.current, coordinate, addressVisit, candidate);
    const admitted =
      directTarget && direct.keyboard && seeded.current
        ? { ...seeded, current: { ...seeded.current, focusId: direct.id } }
        : seeded;
    if (direct && sameFollowingWindow(coordinate, direct.target)) directKindMovement.current = null;
    if (admitted !== navigation.current) {
      navigation.current = admitted;
      setNavigationRevision((revision) => revision + 1);
    }
  });
  const move = (target: FollowingWindow, movement: FollowingMovement, keyboard: boolean) => {
    if (page.forbidden || unsettledRemovals.current.size || navigation.current.staged || directKindMovement.current)
      return false;
    const identity = currentIdentity.current();
    if (!identity) {
      if (
        movement !== 'kind' ||
        target.kind === coordinate.kind ||
        !origin.subject ||
        !origin.allowed[0] ||
        !address.isCurrent() ||
        !origin.current(0)
      )
        return false;
      directKindMovement.current = {
        from: coordinate,
        fromVisit: addressVisit,
        target,
        id: ++nextMovementId.current,
        keyboard,
        subject: origin.subject,
        locale,
        authorityEpoch,
      };
      setNavigationRevision((revision) => revision + 1);
      return true;
    }
    const staged = stageFollowingWindow(navigation.current, {
      from: coordinate,
      addressVisit,
      target,
      movement,
      identity,
      id: ++nextMovementId.current,
      keyboard,
    });
    if (!staged) return false;
    navigation.current = staged;
    setNavigationRevision((revision) => revision + 1);
    if (sameFollowingWindow(target, coordinate)) void read.refetch();
    return true;
  };
  const removalChanged = (targetId: string, unsettled: boolean) => {
    if (unsettled) unsettledRemovals.current.add(targetId);
    else unsettledRemovals.current.delete(targetId);
    setNavigationRevision((revision) => revision + 1);
  };
  const windowNavigation: FollowingWindowNavigation = {
    previous: currentNavigation.previous.at(-1) ?? null,
    busy: currentNavigation.staged !== null || directKindMovement.current !== null,
    unsettledRemoval: unsettledRemovals.current.size > 0,
    ...(currentNavigation.current?.focusId !== undefined ? { focusId: currentNavigation.current.focusId } : {}),
    move,
    removalChanged,
  };
  return (
    <div hidden={origin.hydrated && !origin.allowed[0]}>
      <MineFollowingPageView
        page={page}
        kind={kind}
        cursor={address.cursor}
        invalidAddress={addressInvalid}
        origin={rowOrigin}
        status={status}
        onRefresh={() => {
          if (current()) void read.refetch();
        }}
        navigation={windowNavigation}
        refreshCurrent={current}
        onReview={async (targetId) => {
          if (addressInvalid || !current() || !readCurrent()) return null;
          const result = await read.refetch();
          if (
            !current() ||
            result.isError ||
            !result.data ||
            !origin.subject ||
            !matches(result.data, origin.subject, address.cursor, locale, kind) ||
            origin.client.getQueryState(options.queryKey)?.status !== 'success' ||
            origin.client.getQueryData(options.queryKey) !== result.data
          )
            return null;
          // Absence on a bounded page is not proof that the owner has no edge.
          return result.data.page.follows.some((follow) => follow.targetId === targetId && follow.state === 'following')
            ? { state: 'ready', following: true }
            : null;
        }}
        onRetry={
          status === 'unavailable'
            ? () => {
                if (current() && origin.client.getQueryState(options.queryKey) === retryState) void read.refetch();
              }
            : undefined
        }
      />
    </div>
  );
}

export function MineFollowingPageView({
  page,
  cursor,
  kind = 'all',
  invalidAddress = false,
  origin,
  status,
  onRetry,
  onReview,
  onRefresh,
  refreshCurrent,
  readSpace,
  navigation,
}: {
  page: MineFollowingPage;
  cursor?: string | null | undefined;
  invalidAddress?: boolean;
  kind?: FollowingKind;
  origin?: HistoryOrigin;
  status?: 'unavailable' | 'preparing' | undefined;
  onRetry?: (() => void) | undefined;
  onReview?: ReviewFollow | undefined;
  onRefresh?: (() => void) | undefined;
  refreshCurrent?: (() => boolean) | undefined;
  readSpace?: FollowingSpaceReader | undefined;
  navigation?: FollowingWindowNavigation | undefined;
}) {
  const intentOwners = useRef<{
    lifetime: HistoryOrigin['lifetime'] | undefined;
    byTarget: Map<string, FollowIntentOwner>;
  } | null>(null);
  if (!intentOwners.current || intentOwners.current.lifetime !== origin?.lifetime)
    intentOwners.current = { lifetime: origin?.lifetime, byTarget: new Map() };
  const intentOwnerFor = (targetId: string) => {
    let owner = intentOwners.current!.byTarget.get(targetId);
    if (!owner) {
      owner = createFollowIntent();
      intentOwners.current!.byTarget.set(targetId, owner);
    }
    return owner;
  };
  const requestedAddress = personalDirectoryAddress(cursor ?? undefined, PERSONAL_DIRECTORY_CURSOR_LIMITS.following);
  const addressRejected = invalidAddress || page.addressInvalid || page.kindUnavailable || !requestedAddress.valid;
  const requestedCursor = requestedAddress.cursor;
  // This key tracks follow-command identity. Replaced summaries or Community advice retire reading
  // through page-object identity while the existing FollowTargetControl keeps its uncertain intent.
  const lifetime = JSON.stringify({
    kind,
    signedIn: page.signedIn,
    next: page.next,
    addressInvalid: page.addressInvalid,
    cursorReset: page.cursorReset,
    cursor: requestedCursor,
    follows: page.follows.map(
      ({ idempotencyKey: _key, target: _target, destination: _destination, actions: _actions, ...intent }) => intent,
    ),
  });
  const ref = useRef({
    key: lifetime,
    id: crypto.randomUUID(),
    parent: origin?.lifetime,
    active: true,
    mounted: false,
  });
  if (ref.current.key !== lifetime || ref.current.parent !== origin?.lifetime) {
    ref.current.active = false;
    ref.current = { key: lifetime, id: crypto.randomUUID(), parent: origin?.lifetime, active: true, mounted: false };
  }
  const row = ref.current;
  useLayoutEffect(() => {
    if (row.active) row.mounted = true;
    return () => {
      row.mounted = false;
    };
  }, [row]);
  const originating = {
    lifetime: row,
    isCurrent: () => row.active && row.mounted && (origin?.isCurrent() ?? true),
  };
  return (
    <MineFollowingPageState
      key={row.id}
      page={page}
      kind={kind}
      cursor={requestedCursor}
      addressRejected={addressRejected}
      origin={originating}
      status={status}
      onRetry={onRetry}
      onReview={onReview}
      onRefresh={onRefresh}
      refreshCurrent={refreshCurrent}
      readSpace={readSpace}
      navigation={navigation}
      intentOwnerFor={intentOwnerFor}
    />
  );
}

function MineFollowingPageState({
  page,
  kind,
  cursor,
  addressRejected,
  origin,
  status,
  onRetry,
  onReview,
  onRefresh,
  refreshCurrent,
  readSpace,
  navigation,
  intentOwnerFor,
}: {
  page: MineFollowingPage;
  cursor: string | null;
  kind: FollowingKind;
  addressRejected: boolean;
  origin: HistoryOrigin;
  status?: 'unavailable' | 'preparing' | undefined;
  onRetry?: (() => void) | undefined;
  onReview?: ReviewFollow | undefined;
  onRefresh?: (() => void) | undefined;
  refreshCurrent?: (() => boolean) | undefined;
  readSpace?: FollowingSpaceReader | undefined;
  navigation?: FollowingWindowNavigation | undefined;
  intentOwnerFor: (targetId: string) => FollowIntentOwner;
}) {
  const canUnfollow = useOperation('follow.delete');
  const canReadCollection = useOperation('collection.get');
  const [follows, setFollows] = useState(page.follows);
  const [removed, setRemoved] = useState(false);
  const listHeading = useRef<HTMLHeadingElement>(null);
  const article = useRef<HTMLElement>(null);

  const locale = getLocale();
  const prepared = useMemo(() => prepareFollowing(page, locale), [page, locale]);
  const active = useMemo(() => {
    const activeIds = new Set(follows.map((follow) => follow.targetId));
    return prepared.rows.filter((row) => activeIds.has(row.follow.targetId));
  }, [prepared, follows]);
  const readingOrigin = useHistoryCurrentOrigin(
    JSON.stringify([locale, cursor, canReadCollection]),
    followingReadingOperations,
    null,
    origin,
  );
  const reading = useFollowingSelection(page, locale, {
    lifetime: readingOrigin.boundary.lifetime,
    isCurrent: () =>
      readingOrigin.current(0) &&
      (!canReadCollection || readingOrigin.current(1)) &&
      origin.isCurrent() &&
      getLocale() === locale &&
      !status &&
      !page.forbidden &&
      !addressRejected,
  });
  const restoreFollowingFrontier = () => {
    reading.restoreFocus();
    if (!readingOrigin.subject || !origin.isCurrent()) return;
    const frontier = readFollowingReturn(locale, readingOrigin.subject);
    if (!frontier || !followingReturnMatchesWindow(frontier, cursor, kind)) return;
    followingReturnTrigger(article.current, frontier.targetId)?.focus();
    clearFollowingReturn();
  };
  useFollowingReturn(reading.returnCurrent, reading.suspend, onRefresh, restoreFollowingFrontier);
  useLayoutEffect(() => {
    if (!origin.isCurrent() || !readingOrigin.subject || status) return;
    const frontier = readFollowingReturn(locale, readingOrigin.subject);
    if (!frontier || !followingReturnMatchesWindow(frontier, cursor, kind)) return;
    const trigger = followingReturnTrigger(article.current, frontier.targetId);
    if (!trigger) return;
    trigger.focus();
    clearFollowingReturn();
  }, [active, locale, cursor, kind, readingOrigin.subject, origin, status]);
  const focusedMovement = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (navigation?.focusId === undefined || focusedMovement.current === navigation.focusId || !origin.isCurrent())
      return;
    focusedMovement.current = navigation.focusId;
    listHeading.current?.focus();
  }, [navigation?.focusId]);
  const restart = !addressRejected && (!!cursor || !!page.cursorReset || removed);
  const firstPageEmpty = !restart && !page.next;
  const nextAddress =
    page.next === null ? null : personalDirectoryAddress(page.next, PERSONAL_DIRECTORY_CURSOR_LIMITS.following);
  const nextCursor = nextAddress?.valid ? nextAddress.cursor : null;
  const nextUnavailable = page.next !== null && !nextAddress?.valid;
  const navigationDisabled = !!navigation?.busy || !!navigation?.unsettledRemoval;
  const kindChangeDisabled = page.forbidden || navigationDisabled;
  const navigate = (
    event: ReactMouseEvent<HTMLAnchorElement>,
    target: FollowingWindow,
    movement: FollowingMovement,
  ) => {
    if (
      !navigation ||
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    if (!navigation.move(target, movement, event.detail === 0)) event.preventDefault();
    else reading.close(false);
  };

  return (
    <article ref={article} className="max-w-4xl space-y-8 text-foreground">
      <header>
        <PageHeading ref={listHeading} tabIndex={-1}>
          {m.library_following_heading()}
        </PageHeading>
      </header>
      <nav aria-label={m.following_kind_label()} className="flex flex-wrap gap-2">
        {(['all', 'subject', 'collection', 'space'] as const).map((value) => {
          const label =
            value === 'all'
              ? m.following_kind_all()
              : value === 'subject'
                ? m.following_kind_subject()
                : value === 'collection'
                  ? m.following_kind_collection()
                  : m.following_kind_space();
          const variant = kind === value ? 'default' : 'outline';
          return kindChangeDisabled ? (
            <Button
              key={value}
              variant={variant}
              className="min-h-11"
              disabled
              aria-current={kind === value ? 'page' : undefined}
            >
              {label}
            </Button>
          ) : (
            <Link
              key={value}
              to="/library/following"
              search={value === 'all' ? {} : { kind: value }}
              aria-current={kind === value ? 'page' : undefined}
              className={buttonVariants({ variant, className: 'min-h-11' })}
              onClick={(event) => navigate(event, { cursor: null, kind: value }, 'kind')}
            >
              {label}
            </Link>
          );
        })}
      </nav>
      {!addressRejected && page.forbidden ? <p role="status">{m.library_my_ratings_denied()}</p> : null}
      {navigation?.unsettledRemoval ? <p role="status">{m.following_navigation_recover_removal()}</p> : null}
      {!addressRejected && status ? (
        <div className="space-y-3">
          <p role="status">{status === 'preparing' ? m.library_follow_loading() : m.library_follow_unavailable()}</p>
          {onRetry ? (
            <Button variant="outline" onClick={onRetry}>
              {m.library_follow_retry()}
            </Button>
          ) : null}
        </div>
      ) : null}
      {addressRejected ? (
        <div className="space-y-3">
          <p role="alert">
            {page.kindUnavailable ? m.following_kind_unavailable() : m.library_directory_address_invalid()}
          </p>
          <a href={`/${getLocale()}/library/following`} className={buttonVariants({ variant: 'outline' })}>
            {m.library_directory_address_first_page()}
          </a>
        </div>
      ) : null}
      {!addressRejected && !page.forbidden && page.signedIn && page.cursorReset ? (
        <p role="status">{m.library_collections_cursor_reset()}</p>
      ) : null}
      {!addressRejected && !page.forbidden && page.signedIn && removed ? (
        <p role="status">{m.library_follow_removed()}</p>
      ) : null}
      {reading.suspended ? <p role="status">{m.following_reading_return_preparing()}</p> : null}
      {!addressRejected && page.signedIn && onRefresh ? (
        <Button
          className="min-h-11"
          variant="outline"
          disabled={!!status || navigationDisabled}
          onClick={() => {
            if (refreshCurrent ? !refreshCurrent() : page.forbidden ? !origin.isCurrent() : !reading.returnCurrent())
              return;
            reading.close(false);
            onRefresh();
          }}
        >
          {m.following_reading_refresh()}
        </Button>
      ) : null}
      {reading.selection ? (
        <FollowingInspection
          key={reading.selection.id}
          selection={reading.selection}
          subject={readingOrigin.subject}
          locale={locale}
          canReadCollection={canReadCollection}
          close={reading.close}
          readSpace={readSpace}
          returnFrontier={
            readingOrigin.subject
              ? followingReturnFrontier(
                  locale,
                  readingOrigin.subject,
                  cursor,
                  kind,
                  reading.selection.row.follow.targetId,
                )
              : null
          }
        />
      ) : null}
      {!addressRejected && !page.forbidden && active.length ? (
        <ul className="list-none space-y-1" aria-label={m.library_following_heading()}>
          {active.map((row) => {
            const { follow, title, kind, reason, destination } = row;
            const href =
              reading.suspended || (destination?.kind === 'collection' && !canReadCollection)
                ? undefined
                : destination?.href;
            return (
              <ContentItem
                key={follow.targetId}
                data-follow-target={follow.targetId}
                data-follow-target-type={follow.targetType}
                className="px-4"
                title={title.text}
                {...(title.lang ? { titleLang: title.lang } : {})}
                headingLevel={3}
                {...(href ? { href } : {})}
                onClickCapture={(event) => {
                  if (!(event.target instanceof Element) || !event.target.closest('a')) return;
                  const frontier = readingOrigin.subject
                    ? followingReturnFrontier(locale, readingOrigin.subject, cursor, kind, follow.targetId)
                    : null;
                  followingDestinationClick(event, () => reading.current(), frontier);
                }}
                visual={follow.target?.cover ? <SubjectCover subject={follow.target} ratio="2:3" /> : undefined}
                metadata={
                  <div className="min-w-0 space-y-1">
                    <p>{kind}</p>
                    <p>{reason}</p>
                  </div>
                }
                actions={
                  <div className="flex flex-wrap items-center gap-2">
                    <span hidden={!canUnfollow}>
                      <FollowTargetControl
                        origin={origin}
                        intentOwner={intentOwnerFor(follow.targetId)}
                        targetId={follow.targetId}
                        following
                        disabled={!!status}
                        idempotencyKey={follow.idempotencyKey}
                        menuTitle={m.library_follow_more_actions({ title: title.text })}
                        {...(navigation ? { onRemovalUnsettledChange: navigation.removalChanged } : {})}
                        onReview={onReview ? () => onReview(follow.targetId) : undefined}
                        onRemoved={() => {
                          if (!origin.isCurrent()) return;
                          if (reading.selection?.row.follow.targetId === follow.targetId) {
                            reading.close(false);
                            listHeading.current?.focus();
                          }
                          setFollows((items) => items.filter((item) => item.targetId !== follow.targetId));
                          setRemoved(true);
                        }}
                      />
                    </span>
                    <Button
                      className="min-h-11"
                      variant="outline"
                      disabled={!!status}
                      aria-disabled={reading.suspended || undefined}
                      aria-label={m.following_reading_inspect_target({ title: title.text })}
                      onClick={(event) => {
                        const current = prepared.byId.get(follow.targetId);
                        if (current) reading.select(current, event.currentTarget);
                      }}
                    >
                      {m.following_reading_inspect()}
                    </Button>
                  </div>
                }
              />
            );
          })}
        </ul>
      ) : !addressRejected && !page.forbidden && page.signedIn ? (
        <Empty>
          <EmptyHeader>
            <EmptyDescription>
              {firstPageEmpty ? m.library_following_empty() : m.library_following_page_empty()}
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <a href={`/${getLocale()}/search`} className={buttonVariants({ variant: 'outline' })}>
              {m.search_heading()}
            </a>
          </EmptyContent>
        </Empty>
      ) : null}
      {nextUnavailable && !addressRejected && !page.forbidden ? (
        <p role="status">{m.following_navigation_unavailable()}</p>
      ) : null}
      {!addressRejected && !page.forbidden && page.signedIn && (nextCursor || restart || navigation?.previous) ? (
        <Exposure operation="follow.list">
          <nav
            aria-label={m.library_following_heading()}
            className="flex flex-wrap items-center gap-3"
            aria-busy={navigation?.busy || undefined}
          >
            {navigation?.previous ? (
              navigationDisabled ? (
                <Button variant="outline" disabled>
                  {m.following_navigation_previous()}
                </Button>
              ) : (
                <Link
                  to="/library/following"
                  search={{
                    ...(navigation.previous.cursor === null ? {} : { cursor: navigation.previous.cursor }),
                    ...(navigation.previous.kind === 'all' ? {} : { kind: navigation.previous.kind }),
                  }}
                  onClick={(event) => navigate(event, navigation.previous!, 'previous')}
                  className={buttonVariants({ variant: 'outline' })}
                >
                  {m.following_navigation_previous()}
                </Link>
              )
            ) : null}
            {nextCursor ? (
              navigationDisabled ? (
                <Button disabled>{m.library_collection_more()}</Button>
              ) : (
                <Link
                  to="/library/following"
                  search={{ cursor: nextCursor, ...(kind === 'all' ? {} : { kind }) }}
                  onClick={(event) => navigate(event, { cursor: nextCursor, kind }, 'next')}
                  className="inline-flex min-h-11 items-center rounded-lg border border-border px-4 text-primary underline-offset-4 hover:bg-muted hover:underline"
                >
                  {m.library_collection_more()}
                </Link>
              )
            ) : null}
            {restart ? (
              navigationDisabled ? (
                <Button variant="outline" disabled>
                  {m.library_collections_first_page()}
                </Button>
              ) : (
                <Link
                  to="/library/following"
                  search={kind === 'all' ? {} : { kind }}
                  onClick={(event) => navigate(event, { cursor: null, kind }, 'first')}
                  className={buttonVariants({ variant: 'outline' })}
                >
                  {m.library_collections_first_page()}
                </Link>
              )
            ) : null}
          </nav>
        </Exposure>
      ) : null}
    </article>
  );
}
