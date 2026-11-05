import { useLayoutEffect, useMemo, useRef, useState } from 'react';
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
type Props = { initial: CreatorSalesCurrentRead; locale: string; cursor?: string | undefined;
  navigate?: ((href: string) => void) | undefined };
type Windows = {
  coordinates: CreatorSalesWindows;
  source: object | undefined;
  focus: HTMLElement | undefined;
  admitting: boolean;
};

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
  const { initial, locale, cursor } = props;
  const current = useCreatorCurrentOrigin('commerce_sale.list', JSON.stringify([locale, cursor ?? null]));
  const authority = JSON.stringify([locale, current.state, current.subject,
    current.admission, current.observation, current.exposure, current.csrfToken]);
  const [visit, setVisit] = useState(() => ({ authority, client: current.client, initial, origin: current.origin,
    cursor, transfer: false, windows: { coordinates: new CreatorSalesWindows(cursor), source: undefined,
      focus: undefined, admitting: false } as Windows }));
  let active = visit;
  if (visit.authority !== authority || visit.client !== current.client || visit.initial !== initial ||
      visit.origin !== current.origin || visit.cursor !== cursor) {
    const transfer = visit.authority === authority && visit.client === current.client &&
      visit.initial !== initial && visit.windows.coordinates.staged !== undefined &&
      visit.windows.coordinates.staged.cursor === cursor;
    active = { authority, client: current.client, initial, origin: current.origin, cursor, transfer,
      windows: transfer ? visit.windows : { coordinates: new CreatorSalesWindows(cursor),
        source: undefined, focus: undefined, admitting: false } };
    active.windows.source = undefined;
    active.windows.admitting = transfer;
    setVisit(active);
  }
  const live = useRef(active);
  live.current = active;
  useLayoutEffect(() => {
    const cancel = () => { live.current.windows.focus = undefined; };
    document.addEventListener('focusin', cancel);
    return () => {
      document.removeEventListener('focusin', cancel);
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
      subject={subject}
      origin={current.origin}
      hydrated={current.hydrated}
      revision={admittedLoader.version}
      windows={active.windows}
      seed={active.transfer || current.seed || (admittedLoader.version > 0 && admittedLoader.origin === current.origin.id)}
    />
  );
}

function CurrentSalesRead({
  initial,
  locale,
  cursor,
  subject,
  origin,
  hydrated,
  seed,
  revision,
  windows,
  navigate,
}: Props & {
  subject: string;
  origin: Origin;
  hydrated: boolean;
  seed: boolean;
  revision: number;
  windows: Windows;
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
  if (windows.source && windows.source !== source &&
      (!windows.admitting || !windows.coordinates.staged || windows.coordinates.staged.cursor !== cursor)) {
    windows.coordinates = new CreatorSalesWindows(cursor);
    windows.focus = undefined;
  }
  windows.source = source;
  const staged = windows.coordinates.staged;
  useLayoutEffect(() => {
    if (value?.page.kind !== 'ready' && value?.page.kind !== 'loading') windows.focus = undefined;
    if (!windows.admitting || !staged || staged.cursor !== cursor || value?.page.kind !== 'ready' || !sourceIsCurrent()) return;
    windows.coordinates.accept();
    windows.admitting = false;
    const focus = windows.focus;
    windows.focus = undefined;
    redraw((n) => n + 1);
    if (focus) {
      const heading = document.getElementById('creator-sales-heading');
      heading?.setAttribute('tabindex', '-1');
      heading?.focus();
    }
  });
  const move = (movement: SalesMovement, target: SalesCoordinate, keyboard: boolean, element: HTMLElement) => {
    if (!navigate || !sourceIsCurrent() || (staged && !windows.admitting)) return;
    windows.coordinates.stage(movement, target);
    windows.admitting = false;
    windows.focus = keyboard ? element : undefined;
    redraw((n) => n + 1);
    // Re-admit the initiating source immediately before the existing route navigation.
    if (sourceIsCurrent()) navigate(creatorSalesHref(locale, target));
  };
  if (hydrated && !origin.isCurrent())
    return (
      <CreatorSalesPage page={{ kind: 'loading' }} locale={locale} {...(cursor === undefined ? {} : { cursor })} />
    );
  if (origin.isCurrent()) origin.workspace.read = value;
  const page: CreatorSalesData = value?.page ?? { kind: 'loading' };
  return (
    <CreatorSalesPage
      page={page}
      source={staged ? windows.coordinates.staged : source}
      isCurrent={() => !windows.coordinates.staged && sourceIsCurrent()}
      windows={navigate ? {
        previous: windows.coordinates.previous,
        staged: windows.coordinates.staged,
        move,
        retry: () => { if (origin.isCurrent()) void query.refetch(); },
      } : undefined}
      refreshing={query.isFetching}
      refresh={() => {
        if (sourceIsCurrent()) void query.refetch();
      }}
      locale={locale}
      {...(cursor === undefined ? {} : { cursor })}
    />
  );
}
