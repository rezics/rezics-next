import { QueryClientContext } from '@tanstack/react-query';
import { useCallback, useContext, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { addressLease, browserObservation, type BrowserObservationSnapshot } from '../../../session';
import type { WorkFranchiseReturn } from '../../catalogue/work-franchise-reading/navigation';
import { workFranchiseReturn } from '../../catalogue/work-franchise-reading/navigation';
import { subjectVisitReturn, workFranchiseReturnHref } from '../subject-visit-navigation';

export type WorkReturnFocus = {
  control: 'browse' | 'evidence';
  current: () => boolean;
  complete: () => void;
};

const noObservation = () => undefined;
const noSubscription = () => () => {};

/** Outer visit composition only. Native admission, row order and continuation stay with the supplied reader. */
export function useWorkRegionReturn({
  sources,
  descriptor,
  currentHref,
  fallbackHref,
  locale,
  spoiler,
  release,
  revision,
}: {
  sources: readonly unknown[];
  descriptor: string;
  currentHref?: string | undefined;
  fallbackHref: string;
  locale: string;
  spoiler: number;
  release: string;
  revision: number;
}) {
  const client = useContext(QueryClientContext);
  const store = client ? browserObservation(client) : undefined;
  const origin = workFranchiseReturnHref(currentHref, fallbackHref, locale);
  const address = origin.split('#')[0]!;
  const identity = JSON.stringify([descriptor, address, locale, spoiler, release, revision]);
  const previous = useRef<{
    sources: readonly unknown[];
    identity: string;
    store: typeof store;
    observation: BrowserObservationSnapshot | undefined;
    serial: number;
    lease: ReturnType<typeof addressLease>;
  } | undefined>(undefined);
  const initialized = useRef(false);
  const subscribe = useCallback((notify: () => void) => {
    if (!store) return noSubscription();
    const stop = store.subscribe(notify);
    // The first browser observation binds the already prepared server reading during hydration.
    if (!initialized.current && previous.current?.store === store) {
      previous.current.observation = store.getSnapshot();
      initialized.current = true;
    }
    return stop;
  }, [store]);
  const observation = useSyncExternalStore(
    subscribe,
    store?.getSnapshot ?? noObservation,
    store?.getServerSnapshot ?? noObservation,
  );
  const old = previous.current;
  if (!old || old.sources.length !== sources.length || sources.some((source, index) => source !== old.sources[index])) {
    old?.lease.retire();
    previous.current = {
      sources: [...sources],
      identity,
      store,
      observation,
      serial: (old?.serial ?? 0) + 1,
      lease: addressLease(() => !store || store.getSnapshot() === previous.current?.observation),
    };
  }
  const binding = previous.current!;
  if (binding.identity !== identity || binding.store !== store || binding.observation !== observation)
    binding.lease.retire();
  const current = () => binding.lease.current();
  const [missing, setMissing] = useState(false);
  const visit = useRef({ href: currentHref, consumed: false });
  if (visit.current.href !== currentHref) visit.current = { href: currentHref, consumed: false };
  const accepted = subjectVisitReturn(currentHref, locale);
  const selection = accepted ? workFranchiseReturn(new URL(accepted, 'https://rezics.invalid').hash) : undefined;
  const expected =
    selection &&
    selection.spoiler === spoiler &&
    (selection.release === undefined || selection.release === release) &&
    (selection.revision === undefined || selection.revision === revision);
  const available = current();
  const pending = available && !visit.current.consumed && selection !== undefined;
  const restored = useRef(false);
  restored.current = false;
  const heading = useRef<HTMLHeadingElement>(null);
  const focusFor = (stream: string, node: string, statement: string, holder: string): WorkReturnFocus | undefined => {
    if (
      !pending ||
      !expected ||
      !selection.statement ||
      selection.stream !== stream ||
      (selection.node !== undefined && selection.node !== node) ||
      selection.statement !== statement ||
      selection.holder !== holder
    )
      return;
    return {
      control: selection.focus ?? 'browse',
      current: () => mounted.current && previous.current === binding && current(),
      complete() {
        restored.current = true;
        visit.current.consumed = true;
      },
    };
  };
  const streamFocusFor = (stream: string, node: string) => (element: HTMLHeadingElement | null) => {
    if (
      element &&
      pending &&
      expected &&
      !selection.statement &&
      selection.stream === stream &&
      (selection.node === undefined || selection.node === node) &&
      current()
    ) {
      element.focus({ preventScroll: true });
      restored.current = true;
      visit.current.consumed = true;
    }
  };
  useLayoutEffect(() => {
    if (!pending) return;
    visit.current.consumed = true;
    if (!restored.current) {
      setMissing(true);
      heading.current?.focus({ preventScroll: true });
    } else setMissing(false);
  });
  const mounted = useRef(true);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const returnToFor = (selection: Omit<WorkFranchiseReturn, 'spoiler' | 'release' | 'revision'>) =>
    workFranchiseReturnHref(currentHref, fallbackHref, locale, { ...selection, spoiler, release, revision });
  return {
    available,
    key: String(binding.serial),
    current,
    heading,
    missing,
    focusFor,
    streamFocusFor,
    returnToFor,
    restartHref: workFranchiseReturnHref(undefined, address, locale),
  };
}
