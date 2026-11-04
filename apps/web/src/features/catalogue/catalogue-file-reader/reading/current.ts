import { QueryClientContext } from '@tanstack/react-query';
import { useCallback, useContext, useLayoutEffect, useReducer, useRef, useSyncExternalStore } from 'react';
import { addressLease } from '../../../../reader/lease';
import { browserObservation, type BrowserObservationSnapshot } from '../../../../session/observation';

const noSubscribe = () => () => {};
const unobserved = () => 'unobserved';
type InspectionKind = 'assertion' | 'association';
type Selection = { key: string; group: string; kind: InspectionKind };
type Receipt = { opener?: HTMLButtonElement; fallback?: HTMLElement; keyboard: boolean };
type Recovery = { destination: string; state: 'pending' | 'failed' };

type CurrentReading = {
  source: object;
  descriptor: string;
  cache: string;
  observation: ReturnType<typeof browserObservation> | undefined;
  session: BrowserObservationSnapshot | undefined;
  retired: boolean;
  active: boolean;
  selection?: Selection;
  receipt?: Receipt;
  recovery?: Recovery;
  cancelFocus?: () => void;
  lease: ReturnType<typeof addressLease>;
  owns: () => boolean;
  current: () => boolean;
  retire: () => void;
};

function scheduleFocus(episode: CurrentReading, target: HTMLElement | undefined) {
  episode.cancelFocus?.();
  if (!target || typeof window === 'undefined') return;
  let cancelled = false;
  const removeListeners = () => {
    window.removeEventListener('pointerdown', cancel, true);
    window.removeEventListener('keydown', cancel, true);
    window.removeEventListener('focusin', cancel, true);
    episode.cancelFocus = undefined;
  };
  const cancel = () => {
    cancelled = true;
    removeListeners();
  };
  window.addEventListener('pointerdown', cancel, true);
  window.addEventListener('keydown', cancel, true);
  window.addEventListener('focusin', cancel, true);
  const frame = window.requestAnimationFrame(() => {
    removeListeners();
    if (!cancelled && episode.current() && target.isConnected) target.focus();
  });
  episode.cancelFocus = () => {
    cancelled = true;
    window.cancelAnimationFrame(frame);
    removeListeners();
  };
}

function createReading(
  source: object,
  descriptor: string,
  cache: string,
  observation: ReturnType<typeof browserObservation> | undefined,
  session: BrowserObservationSnapshot | undefined,
) {
  const reading = {
    source,
    descriptor,
    cache,
    observation,
    session,
    retired: false,
    active: false,
    selection: undefined as Selection | undefined,
    receipt: undefined as Receipt | undefined,
    recovery: undefined as Recovery | undefined,
    cancelFocus: undefined as (() => void) | undefined,
    lease: undefined as unknown as ReturnType<typeof addressLease>,
    owns: () => true,
    current: () => false,
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
  cacheSource?: object;
  currentHref?: string;
  recoverCurrentPage?: () => Promise<void>;
}) {
  const client = useContext(QueryClientContext);
  const observation = client ? browserObservation(client) : undefined;
  const session = useSyncExternalStore(
    observation?.subscribe ?? noSubscribe,
    observation?.getSnapshot ?? (() => undefined),
    observation?.getServerSnapshot ?? (() => undefined),
  );
  const cacheSource = input.cacheSource ?? input.source;
  const cacheSnapshot = useCallback(() => {
    if (!client) return unobserved();
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
    return JSON.stringify([stamp(['session']), subjects, stamp(['exposure', 'viewer']), viewers]);
  }, [client, cacheSource]);
  const cache = useSyncExternalStore(observation?.subscribeCache ?? noSubscribe, cacheSnapshot, cacheSnapshot);
  const holder = useRef<CurrentReading | undefined>(undefined);
  const [, refresh] = useReducer((version: number) => version + 1, 0);
  const descriptor = JSON.stringify([input.descriptor, session]);
  if (
    !holder.current ||
    holder.current.source !== input.source ||
    holder.current.observation !== observation ||
    holder.current.descriptor !== descriptor ||
    holder.current.cache !== cache ||
    holder.current.session !== session
  ) {
    holder.current?.retire();
    holder.current = createReading(input.source, descriptor, cache, observation, session);
  }
  const episode = holder.current;
  episode.owns = () =>
    holder.current === episode &&
    cacheSnapshot() === episode.cache &&
    (!observation || observation.getSnapshot() === episode.session);
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
    (selection: Selection, opener: HTMLButtonElement, fallback: HTMLElement | undefined, keyboard: boolean) => {
      if (!episode.current()) return;
      episode.cancelFocus?.();
      episode.selection = selection;
      episode.receipt = {
        ...(keyboard ? { opener } : {}),
        ...(fallback ? { fallback } : {}),
        keyboard,
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

  return {
    episode,
    selection: episode.selection,
    recovery: episode.recovery,
    select,
    close,
    retry,
  };
}
