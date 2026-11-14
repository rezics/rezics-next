import { QueryClientContext } from '@tanstack/react-query';
import { useCallback, useContext, useLayoutEffect, useReducer, useRef, useSyncExternalStore } from 'react';
import { addressLease } from '../../../../reader/lease';
import { browserObservation, type BrowserObservationSnapshot } from '../../../../session/observation';

const noSubscribe = () => () => {};
const unobserved = JSON.stringify(['unobserved', 'unobserved']);
type InspectionKind = 'assertion' | 'association';
type Selection = { key: string; group: string; kind: InspectionKind; part?: string | undefined };
type Receipt = {
  opener?: HTMLButtonElement;
  fallback?: HTMLElement;
  keyboard: boolean;
  returning?: boolean;
  focusAllowed: boolean;
};
type Recovery = { destination: string; state: 'pending' | 'failed' };

type CurrentReading = {
  source: object;
  descriptor: string;
  cache: string;
  sessionCache: string;
  spoiler: number | undefined;
  observation: ReturnType<typeof browserObservation> | undefined;
  session: BrowserObservationSnapshot | undefined;
  sessionBound: boolean;
  returnInterrupted: boolean;
  retired: boolean;
  active: boolean;
  selection: Selection | undefined;
  receipt: Receipt | undefined;
  recovery: Recovery | undefined;
  cancelFocus: (() => void) | undefined;
  lease: ReturnType<typeof addressLease>;
  owns: () => boolean;
  current: () => boolean;
  retire: () => void;
};

function scheduleFocus(episode: CurrentReading, target: HTMLElement | undefined, preserveFocus = false) {
  episode.cancelFocus?.();
  if (!target || typeof window === 'undefined') return;
  const active = window.document.activeElement;
  if (preserveFocus && active?.isConnected && active !== window.document.body) return;
  let cancelled = false;
  let frame = 0;
  const removeListeners = () => {
    window.removeEventListener('pointerdown', cancel, true);
    window.removeEventListener('keydown', cancel, true);
    window.removeEventListener('focusin', cancel, true);
    if (episode.cancelFocus === cancel) episode.cancelFocus = undefined;
  };
  const cancel = () => {
    cancelled = true;
    window.cancelAnimationFrame(frame);
    removeListeners();
  };
  window.addEventListener('pointerdown', cancel, true);
  window.addEventListener('keydown', cancel, true);
  window.addEventListener('focusin', cancel, true);
  frame = window.requestAnimationFrame(() => {
    removeListeners();
    if (!cancelled && episode.current() && target.isConnected) target.focus();
  });
  episode.cancelFocus = cancel;
}

function createReading(
  source: object,
  descriptor: string,
  cache: string,
  sessionCache: string,
  spoiler: number | undefined,
  observation: ReturnType<typeof browserObservation> | undefined,
  session: BrowserObservationSnapshot | undefined,
) {
  const reading = {
    source,
    descriptor,
    cache,
    sessionCache,
    spoiler,
    observation,
    session,
    sessionBound: session?.state === 'signed-in' || session?.state === 'signed-out',
    returnInterrupted: false,
    retired: false as boolean,
    active: false as boolean,
    selection: undefined as Selection | undefined,
    receipt: undefined as Receipt | undefined,
    recovery: undefined as Recovery | undefined,
    cancelFocus: undefined as (() => void) | undefined,
    lease: undefined as unknown as ReturnType<typeof addressLease>,
    owns: () => true,
    current: () => false as boolean,
    retire: () => {},
  } satisfies CurrentReading;
  reading.lease = addressLease(() => reading.active && !reading.retired && reading.owns());
  reading.current = () => !reading.retired && reading.lease.current();
  reading.retire = () => {
    if (reading.retired) return;
    reading.retired = true;
    reading.lease.retire();
    reading.selection = undefined;
    reading.receipt = undefined;
    reading.recovery = undefined;
    reading.cancelFocus?.();
  };
  return reading;
}

/** One current Subject composition owns its selection, focus receipt and page recovery. */
export function useCatalogueFileReading(input: {
  source: object;
  descriptor: string;
  spoiler?: number | undefined;
  cacheSource?: object;
  currentHref?: string | undefined;
  recoverCurrentPage?: (() => Promise<void>) | undefined;
}) {
  const client = useContext(QueryClientContext);
  const observation = client ? browserObservation(client) : undefined;
  const holder = useRef<CurrentReading | undefined>(undefined);
  const session = useSyncExternalStore(
    observation?.subscribe ?? noSubscribe,
    observation?.getSnapshot ?? (() => undefined),
    observation?.getServerSnapshot ?? (() => undefined),
  );
  const cacheSource = input.cacheSource ?? input.source;
  const cacheSnapshot = useCallback(() => {
    if (!client) return unobserved;
    const stamp = (key: readonly unknown[]) => {
      const state = client.getQueryState(key);
      return [state?.status, state?.fetchStatus, state?.isInvalidated, state?.dataUpdateCount, state?.errorUpdateCount];
    };
    const subjects = client
      .getQueryCache()
      .findAll({
        predicate: (query) => {
          const data: unknown = query.state.data;
          return (
            data === cacheSource ||
            (typeof data === 'object' && data !== null && 'page' in data && data.page === cacheSource)
          );
        },
      })
      .map((query) => [query.queryHash, stamp(query.queryKey)])
      .sort((left, right) => String(left[0]).localeCompare(String(right[0])));
    const viewers = client
      .getQueryCache()
      .findAll({ queryKey: ['exposure', 'viewer'] })
      .map((query) => [query.queryHash, stamp(query.queryKey)])
      .sort((left, right) => String(left[0]).localeCompare(String(right[0])));
    return JSON.stringify([
      JSON.stringify([subjects, stamp(['exposure', 'viewer']), viewers]),
      JSON.stringify(stamp(['session'])),
    ]);
  }, [client, cacheSource]);
  const subscribeCache = useCallback(
    (notify: () => void) =>
      observation?.subscribeCache(() => {
        const episode = holder.current;
        const observed = observation.getSnapshot();
        const [cache, sessionCache] = JSON.parse(cacheSnapshot()) as [string, string];
        if (episode && episode.observation === observation && episode.cache === cache) {
          if (episode.sessionBound) {
            if (episode.session !== observed || episode.sessionCache !== sessionCache) episode.retire();
          } else {
            // Bind in the existing cache subscription, before another authority can replace it.
            episode.session = observed;
            episode.sessionCache = sessionCache;
            episode.sessionBound = observed.state === 'signed-in' || observed.state === 'signed-out';
          }
        }
        notify();
      }) ?? noSubscribe(),
    [observation, cacheSnapshot],
  );
  const snapshot = useSyncExternalStore(subscribeCache, cacheSnapshot, cacheSnapshot);
  const [cache, sessionCache] = JSON.parse(snapshot) as [string, string];
  const [, refresh] = useReducer((version: number) => version + 1, 0);
  if (
    !holder.current ||
    holder.current.source !== input.source ||
    holder.current.observation !== observation ||
    holder.current.descriptor !== input.descriptor ||
    holder.current.cache !== cache ||
    (holder.current.spoiler !== undefined && holder.current.spoiler !== input.spoiler) ||
    (holder.current.sessionBound &&
      (holder.current.session !== session || holder.current.sessionCache !== sessionCache))
  ) {
    holder.current?.retire();
    holder.current = createReading(
      input.source,
      input.descriptor,
      cache,
      sessionCache,
      input.spoiler,
      observation,
      session,
    );
  }
  const episode = holder.current!;
  // First preparation binds the admitted source; only subsequent replacements retire it.
  episode.spoiler = input.spoiler;
  episode.session = session;
  episode.sessionCache = sessionCache;
  episode.sessionBound ||= session?.state === 'signed-in' || session?.state === 'signed-out';
  episode.owns = () => {
    const [currentCache, currentSessionCache] = JSON.parse(cacheSnapshot()) as [string, string];
    return (
      holder.current === episode &&
      currentCache === episode.cache &&
      (!episode.sessionBound ||
        ((!observation || observation.getSnapshot() === episode.session) &&
          currentSessionCache === episode.sessionCache))
    );
  };
  useLayoutEffect(() => {
    episode.active = true;
    const depart = () => {
      episode.retire();
      refresh();
    };
    window.addEventListener('pagehide', depart);
    return () => {
      window.removeEventListener('pagehide', depart);
      episode.active = false;
      queueMicrotask(() => {
        if (!episode.active) episode.retire();
      });
    };
  }, [episode]);

  const select = useCallback(
    (
      selection: Selection,
      opener: HTMLButtonElement,
      fallback: HTMLElement | undefined,
      keyboard: boolean,
      returning = false,
      focusAllowed = true,
    ) => {
      if (!episode.current()) return;
      episode.cancelFocus?.();
      if (!returning) episode.returnInterrupted = true;
      episode.selection = selection;
      episode.receipt = {
        ...(keyboard ? { opener } : {}),
        ...(fallback ? { fallback } : {}),
        keyboard,
        returning,
        focusAllowed,
      };
      episode.recovery = undefined;
      refresh();
    },
    [episode],
  );

  const close = useCallback(
    (fallback: HTMLElement | undefined) => {
      if (!episode.current() || !episode.selection) return;
      const receipt = episode.receipt;
      episode.returnInterrupted = true;
      const opener =
        receipt?.keyboard && receipt.opener?.isConnected && !receipt.opener.disabled ? receipt.opener : undefined;
      const group = receipt?.fallback?.isConnected ? receipt.fallback : fallback;
      episode.selection = undefined;
      episode.receipt = undefined;
      refresh();
      scheduleFocus(episode, opener ?? group);
    },
    [episode],
  );

  const retry = useCallback(async () => {
    if (!episode.current() || episode.recovery?.state === 'pending') return;
    const destination =
      input.currentHref ??
      (typeof window === 'undefined'
        ? ''
        : `${window.location.pathname}${window.location.search}${window.location.hash}`);
    episode.recovery = { destination, state: 'pending' };
    refresh();
    try {
      if (input.recoverCurrentPage) await input.recoverCurrentPage();
      else if (destination && typeof window !== 'undefined') window.location.assign(destination);
      else throw new Error('Current Subject destination is unavailable');
      if (!episode.current()) return;
      episode.recovery = undefined;
    } catch {
      if (!episode.current()) return;
      episode.recovery = { destination, state: 'failed' };
    }
    refresh();
  }, [episode, input.currentHref, input.recoverCurrentPage]);

  const focus = useCallback(
    (target: HTMLElement | undefined, preserveFocus = episode.receipt?.returning ?? false) => {
      if (episode.current() && (!preserveFocus || episode.receipt?.focusAllowed !== false))
        scheduleFocus(episode, target, preserveFocus);
    },
    [episode],
  );

  return {
    focus,
    episode,
    selection: episode.selection,
    recovery: episode.recovery,
    select,
    close,
    retry,
  };
}
