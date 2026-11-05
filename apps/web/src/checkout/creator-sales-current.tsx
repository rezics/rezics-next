import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AnyRouter } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { personalRead } from '../kernel/query';
import { useCreatorCurrentOrigin } from './creator-current-origin';
import {
  parseCreatorSalesPage,
  readCreatorSalesCurrent,
  type CreatorSalesCurrentRead,
  type CreatorSalesData,
} from './creator-sales';
import { CreatorSalesPage, creatorSalesHref } from './creator-sales-page';
import { CreatorSalesWindows, type SalesCoordinate, type SalesMovement } from './creator-sales-windows';

type Origin = ReturnType<typeof useCreatorCurrentOrigin>['origin'];
type Props = {
  initial: CreatorSalesCurrentRead;
  loadId?: string | undefined;
  locationKey?: string | undefined;
  locale: string;
  cursor?: string | undefined;
  navigate?: CreatorSalesNavigate | undefined;
};
export type CreatorSalesRouteLoad = { loadId: string; initial?: CreatorSalesCurrentRead };
export type CreatorSalesRouteAdmission = { locationKey: string; loadId: string };
export type CreatorSalesNavigate = (
  href: string,
  started: (locationKey: string) => void,
) => Promise<CreatorSalesRouteAdmission | undefined>;
type Windows = {
  coordinates: CreatorSalesWindows;
  source: object | undefined;
  focus: HTMLElement | undefined;
  admitting: boolean;
  completed: { attempt: object; locationKey: string; loadId: string } | undefined;
  targetLocationKey: string | undefined;
  transferredLoadId: string | undefined;
  activeCursor: SalesCoordinate;
  navigationPending: boolean;
  navigationFailed: boolean;
  retrying: boolean;
};

export async function navigateCreatorSales(
  router: AnyRouter,
  href: string,
  started: (locationKey: string) => void,
): Promise<CreatorSalesRouteAdmission | undefined> {
  let locationKey: string | undefined;
  let loaded: CreatorSalesRouteAdmission | undefined;
  const stopStart = router.subscribe('onBeforeNavigate', ({ toLocation }) => {
    if (locationKey === undefined) {
      locationKey = toLocation.key;
      started(locationKey);
    }
  });
  const stopResolve = router.subscribe('onResolved', ({ toLocation }) => {
    if (loaded || toLocation.key !== locationKey) return;
    const data = router.state.matches.at(-1)?.loaderData as CreatorSalesRouteLoad | undefined;
    if (data) loaded = { locationKey, loadId: data.loadId };
  });
  try {
    await router.navigate({ href });
  } catch (error) {
    if (!(error instanceof Error) || (error.name !== 'CancelledError' && error.name !== 'AbortError')) throw error;
    return undefined;
  } finally {
    stopStart();
    stopResolve();
  }
  return router.state.location.key === locationKey ? loaded : undefined;
}

function matches(value: unknown, subject: string, cursor: string | null): value is CreatorSalesCurrentRead {
  if (
    !value ||
    typeof value !== 'object' ||
    !('sessionSubject' in value) ||
    value.sessionSubject !== subject ||
    !('requested' in value) ||
    !value.requested ||
    typeof value.requested !== 'object' ||
    !('cursor' in value.requested) ||
    value.requested.cursor !== cursor ||
    !('selling' in value) ||
    typeof value.selling !== 'boolean' ||
    !('page' in value) ||
    !value.page ||
    typeof value.page !== 'object' ||
    !('kind' in value.page)
  )
    return false;
  return value.page.kind === 'ready'
    ? value.selling && parseCreatorSalesPage(value.page) !== null
    : ['denied', 'unavailable', 'error', 'stale', 'loading'].includes(String(value.page.kind));
}

export function CreatorSalesCurrent(props: Props) {
  const { initial, loadId, locationKey, locale, cursor } = props;
  const current = useCreatorCurrentOrigin('commerce_sale.list', JSON.stringify([locale, cursor ?? null]));
  const authority = JSON.stringify([
    locale,
    current.state,
    current.subject,
    current.admission,
    current.observation,
    current.exposure,
    current.csrfToken,
  ]);
  const [visit, setVisit] = useState(() => ({
    authority,
    client: current.client,
    initial,
    loadId,
    locationKey,
    origin: current.origin,
    cursor,
    transfer: false,
    windows: {
      coordinates: new CreatorSalesWindows(cursor),
      source: undefined,
      focus: undefined,
      admitting: false,
      completed: undefined,
      targetLocationKey: undefined,
      transferredLoadId: undefined,
      activeCursor: cursor,
      navigationPending: false,
      navigationFailed: false,
      retrying: false,
    } as Windows,
  }));
  let active = visit;
  if (
    visit.authority !== authority ||
    visit.client !== current.client ||
    visit.initial !== initial ||
    visit.loadId !== loadId ||
    visit.locationKey !== locationKey ||
    visit.origin !== current.origin ||
    visit.cursor !== cursor
  ) {
    const transfer =
      visit.authority === authority &&
      visit.client === current.client &&
      visit.initial !== initial &&
      visit.windows.coordinates.staged !== undefined &&
      visit.windows.targetLocationKey !== undefined &&
      visit.windows.targetLocationKey === locationKey &&
      (!visit.windows.transferredLoadId || visit.windows.transferredLoadId === loadId) &&
      (!visit.windows.completed || visit.windows.completed.loadId === loadId) &&
      visit.windows.coordinates.staged.cursor === cursor;
    active = {
      authority,
      client: current.client,
      initial,
      loadId,
      locationKey,
      origin: current.origin,
      cursor,
      transfer,
      windows: transfer
        ? visit.windows
        : {
            coordinates: new CreatorSalesWindows(cursor),
            source: undefined,
            focus: undefined,
            admitting: false,
            completed: undefined,
            targetLocationKey: undefined,
            transferredLoadId: undefined,
            activeCursor: cursor,
            navigationPending: false,
            navigationFailed: false,
            retrying: false,
          },
    };
    if (transfer) active.windows.transferredLoadId ??= loadId;
    active.windows.source = undefined;
    active.windows.admitting = false;
    active.windows.activeCursor = cursor;
    setVisit(active);
  }
  const [, wake] = useState(0);
  const live = useRef(active);
  const mounted = useRef(false);
  live.current = active;
  useLayoutEffect(() => {
    mounted.current = true;
    const cancel = (event: FocusEvent) => {
      const pending = live.current.windows.focus;
      if (pending && (event.target === pending || event.target === document.body)) return;
      live.current.windows.focus = undefined;
    };
    document.addEventListener('focusin', cancel);
    window.addEventListener('blur', cancel);
    return () => {
      mounted.current = false;
      document.removeEventListener('focusin', cancel);
      window.removeEventListener('blur', cancel);
      live.current.windows.focus = undefined;
    };
  }, []);
  const [loader, setLoader] = useState({ initial, version: 0, origin: current.origin.id });
  let admittedLoader = loader;
  if (loader.initial !== initial) {
    admittedLoader = { initial, version: loader.version + 1, origin: current.origin.id };
    setLoader(admittedLoader);
    current.origin.workspace.read = undefined;
  }
  const subject = current.hydrated ? current.subject : initial.sessionSubject;
  const admitted = current.hydrated ? current.origin.isCurrent() : initial.selling;
  if (!subject || !admitted) {
    if (!current.hydrated && initial.page.kind !== 'ready')
      return <CreatorSalesPage page={initial.page} locale={locale} {...(cursor === undefined ? {} : { cursor })} />;
    const kind =
      current.state === 'unavailable' || current.admission === 'unavailable'
        ? 'unavailable'
        : current.state === 'signed-out' || current.admission === 'closed'
          ? 'denied'
          : 'loading';
    return <CreatorSalesPage page={{ kind }} locale={locale} {...(cursor === undefined ? {} : { cursor })} />;
  }
  return (
    <CurrentSalesRead
      key={`${current.origin.id}:${admittedLoader.version}`}
      {...props}
      loadId={loadId}
      locationKey={locationKey}
      subject={subject}
      origin={current.origin}
      hydrated={current.hydrated}
      revision={admittedLoader.version}
      windows={active.windows}
      settled={() => {
        if (mounted.current && live.current.windows === active.windows) wake((n) => n + 1);
      }}
      seed={
        active.transfer || current.seed || (admittedLoader.version > 0 && admittedLoader.origin === current.origin.id)
      }
    />
  );
}

function CurrentSalesRead({
  initial,
  loadId,
  locationKey,
  locale,
  cursor,
  subject,
  origin,
  hydrated,
  seed,
  revision,
  windows,
  navigate,
  settled,
}: Props & {
  loadId: string | undefined;
  locationKey: string | undefined;
  subject: string;
  origin: Origin;
  hydrated: boolean;
  seed: boolean;
  revision: number;
  windows: Windows;
  settled: () => void;
}) {
  const client = useQueryClient();
  const [, redraw] = useState(0);
  const queryKey = ['creator-sales-current', subject, locale, cursor ?? null, origin.id, revision];
  const seedData = () => {
    const retained = origin.workspace.read;
    const value = retained ?? (seed ? initial : undefined);
    return matches(value, subject, cursor ?? null) ? value : undefined;
  };
  // Remember only whether this mount was seeded, not another private page snapshot.
  const [seeded] = useState(() => seedData() !== undefined);
  const query = useQuery<CreatorSalesCurrentRead | null>({
    ...personalRead,
    queryKey,
    notifyOnChangeProps: 'all',
    enabled: hydrated && origin.isCurrent() && personalRead.enabled,
    queryFn: async () => {
      if (!origin.isCurrent()) return null;
      const unavailable: CreatorSalesCurrentRead = {
        sessionSubject: subject,
        requested: { cursor: cursor ?? null },
        selling: true,
        page: { kind: 'unavailable' },
      };
      try {
        const value = await readCreatorSalesCurrent({ data: cursor ? { cursor } : {} });
        if (!origin.isCurrent()) return null;
        return matches(value, subject, cursor ?? null) ? value : unavailable;
      } catch {
        return origin.isCurrent() ? unavailable : null;
      }
    },
    initialData: seedData,
    refetchOnMount: !seeded,
    structuralSharing: false,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const value = query.data;
  const observation = client.getQueryState(queryKey)?.dataUpdateCount;
  // Count successful observations, including responses equal to their predecessor.
  const source = useMemo(() => ({}), [value, observation]);
  const credential = origin.csrfToken();
  const sourceIsCurrent = () =>
    origin.csrfToken() === credential &&
    origin.isCurrent() &&
    client.getQueryState(queryKey)?.dataUpdateCount === observation &&
    client.getQueryState(queryKey)?.fetchStatus !== 'fetching' &&
    client.getQueryData(queryKey) === value;
  if (
    windows.source &&
    windows.source !== source &&
    (!windows.retrying || !windows.coordinates.staged || windows.coordinates.staged.cursor !== cursor) &&
    !(
      seed &&
      windows.coordinates.staged?.cursor === cursor &&
      windows.targetLocationKey === locationKey &&
      windows.transferredLoadId === loadId &&
      value === initial
    )
  ) {
    windows.coordinates = new CreatorSalesWindows(cursor);
    windows.focus = undefined;
    windows.completed = undefined;
    windows.targetLocationKey = undefined;
    windows.transferredLoadId = undefined;
    windows.admitting = false;
    windows.navigationPending = false;
    windows.navigationFailed = false;
  }
  const staged = windows.coordinates.staged;
  if (
    staged &&
    windows.completed?.attempt === staged &&
    (windows.completed.locationKey !== locationKey || windows.completed.loadId !== loadId)
  ) {
    windows.coordinates = new CreatorSalesWindows(cursor);
    windows.focus = undefined;
    windows.completed = undefined;
    windows.targetLocationKey = undefined;
    windows.transferredLoadId = undefined;
    windows.admitting = false;
    windows.navigationPending = false;
    windows.navigationFailed = false;
  }
  if (windows.source !== source) windows.retrying = false;
  windows.source = source;
  const activeStage = windows.coordinates.staged;
  useLayoutEffect(() => {
    if (value?.page.kind !== 'ready' && value?.page.kind !== 'loading') windows.focus = undefined;
    if (
      windows.completed?.attempt !== activeStage ||
      !windows.admitting ||
      !activeStage ||
      windows.completed.locationKey !== locationKey ||
      windows.completed.loadId !== loadId ||
      activeStage.cursor !== cursor ||
      value?.page.kind !== 'ready' ||
      !sourceIsCurrent()
    )
      return;
    windows.coordinates.accept();
    windows.completed = undefined;
    windows.targetLocationKey = undefined;
    windows.transferredLoadId = undefined;
    windows.admitting = false;
    windows.navigationPending = false;
    windows.navigationFailed = false;
    windows.retrying = false;
    const focus = windows.focus;
    windows.focus = undefined;
    redraw((n) => n + 1);
    if (focus) {
      const heading = document.getElementById('creator-sales-heading');
      heading?.setAttribute('tabindex', '-1');
      heading?.focus();
    }
  });
  const move = (
    movement: SalesMovement,
    target: SalesCoordinate,
    keyboard: boolean,
    element?: HTMLElement,
    retry = false,
  ) => {
    if (
      !navigate ||
      !sourceIsCurrent() ||
      (windows.coordinates.staged && !windows.admitting && !retry) ||
      (retry && !windows.navigationFailed)
    )
      return;
    windows.coordinates.stage(movement, target);
    windows.admitting = false;
    windows.completed = undefined;
    windows.targetLocationKey = undefined;
    windows.transferredLoadId = undefined;
    windows.navigationPending = true;
    windows.navigationFailed = false;
    const attempt = windows.coordinates.staged;
    windows.focus = keyboard ? element : undefined;
    if (sourceIsCurrent()) {
      void navigate(creatorSalesHref(locale, target), (targetLocationKey) => {
        if (windows.coordinates.staged !== attempt) return;
        windows.targetLocationKey = targetLocationKey;
      }).then((result) => {
        if (windows.coordinates.staged !== attempt) return;
        windows.navigationPending = false;
        if (!result || result.locationKey !== windows.targetLocationKey) {
          windows.focus = undefined;
          if (windows.activeCursor === attempt.cursor) {
            windows.coordinates = new CreatorSalesWindows(windows.activeCursor);
            windows.completed = undefined;
            windows.targetLocationKey = undefined;
            windows.transferredLoadId = undefined;
            windows.admitting = false;
            windows.navigationFailed = false;
          } else {
            windows.navigationFailed = true;
          }
          settled();
          return;
        }
        if (windows.transferredLoadId && windows.transferredLoadId !== result.loadId) {
          windows.coordinates = new CreatorSalesWindows(windows.activeCursor);
          windows.focus = undefined;
          windows.completed = undefined;
          windows.targetLocationKey = undefined;
          windows.transferredLoadId = undefined;
          windows.admitting = false;
          windows.navigationPending = false;
          windows.navigationFailed = false;
          windows.retrying = false;
          settled();
          return;
        }
        windows.completed = { attempt, ...result };
        windows.admitting = true;
        settled();
      });
    } else {
      windows.navigationPending = false;
      windows.navigationFailed = true;
      windows.transferredLoadId = undefined;
      windows.focus = undefined;
      settled();
    }
    redraw((n) => n + 1);
  };
  if (hydrated && !origin.isCurrent())
    return (
      <CreatorSalesPage page={{ kind: 'loading' }} locale={locale} {...(cursor === undefined ? {} : { cursor })} />
    );
  if (origin.isCurrent()) origin.workspace.read = value;
  const page: CreatorSalesData = windows.navigationFailed ? { kind: 'unavailable' } : (value?.page ?? { kind: 'loading' });
  return (
    <CreatorSalesPage
      page={page}
      source={activeStage ? windows.coordinates.staged : source}
      isCurrent={() => !windows.coordinates.staged && sourceIsCurrent()}
      windows={
        navigate
          ? {
              previous: windows.coordinates.previous,
              staged: windows.coordinates.staged,
              move,
              retry: () => {
                const target = windows.coordinates.staged;
                if (!target || !sourceIsCurrent()) return;
                if (windows.navigationFailed) move(target.movement, target.cursor, false, undefined, true);
                else if (target.cursor === cursor) {
                  windows.retrying = true;
                  windows.navigationFailed = false;
                  void query.refetch();
                }
              },
            }
          : undefined
      }
      refreshing={query.isFetching}
      refresh={() => {
        if (!windows.coordinates.staged && sourceIsCurrent()) void query.refetch();
      }}
      locale={locale}
      {...(cursor === undefined ? {} : { cursor })}
    />
  );
}
