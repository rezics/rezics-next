import { useEffect, useRef, useState } from 'react';
import type { OwnClassificationsRead } from './actions';
import { classificationAddressKey, indexOwnClassifications, OWN_CLASSIFICATIONS_SOURCE } from './inventory';
import { OwnClassificationsWorkspace } from './page';
import type { ClassificationCommands } from './editor';
import type { ClassificationFrontier, OwnClassificationsState } from './types';

export type OwnClassificationsReadFn = (
  frontier: ClassificationFrontier,
  signal?: AbortSignal,
) => Promise<OwnClassificationsRead>;

/** Loader feedback cannot be borrowed by another account, locale or selected continuation. */
export function classificationReadMatches(
  read: OwnClassificationsRead,
  subject: string,
  locale: string,
  frontier: ClassificationFrontier,
): boolean {
  if (read.state === 'ready') {
    try {
      if (read.source !== OWN_CLASSIFICATIONS_SOURCE || read.page.viewer.accountId !== subject) return false;
      indexOwnClassifications(read.page, frontier);
    } catch {
      return false;
    }
  }
  return (
    (read.subject === subject || (read.state === 'signed-out' && read.subject === null)) &&
    read.locale === locale &&
    classificationAddressKey(read.frontier) === classificationAddressKey(frontier)
  );
}

/** Every admission reads this exact frontier anew; loader rows never admit a browser command. */
export function ClassificationsReader({
  initial,
  frontier,
  locale,
  subject,
  state,
  isCurrent,
  read,
  commands,
  onNext = () => {},
}: {
  initial: OwnClassificationsRead;
  frontier: ClassificationFrontier;
  locale: string;
  subject: string | null;
  state: OwnClassificationsState | null;
  isCurrent: () => boolean;
  read: OwnClassificationsReadFn;
  commands?: Omit<ClassificationCommands, 'read' | 'retire'>;
  onNext?: (frontier: ClassificationFrontier) => void;
}) {
  const latest = useRef({
    subject,
    locale,
    address: classificationAddressKey(frontier),
    initial,
    state,
    active: true,
    abort: new AbortController(),
  });
  const address = classificationAddressKey(frontier);
  if (
    !latest.current.active ||
    latest.current.subject !== subject ||
    latest.current.locale !== locale ||
    latest.current.address !== address ||
    latest.current.state !== state ||
    latest.current.initial !== initial
  ) {
    latest.current.active = false;
    latest.current.abort.abort();
    latest.current = { subject, locale, address, initial, state, active: true, abort: new AbortController() };
  }
  const visit = latest.current;
  const [result, update] = useState<{ visit: object; value: OwnClassificationsRead } | null>(null);
  if (result && result.visit !== visit) update(null);
  const [pending, setPending] = useState<object | null>(null);
  const mounted = useRef(false);
  const inFlight = useRef<object | null>(null);
  const started = useRef<object | null>(null);
  const retire = () => {
    visit.active = false;
    visit.abort.abort();
  };
  const current = () => {
    if (!mounted.current) return false;
    const live = latest.current === visit && visit.active && state === null && isCurrent();
    if (!live) retire();
    return live;
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      visit.active = false;
      visit.abort.abort();
    };
  }, [visit]);
  const candidate =
    result?.visit === visit
      ? result.value
      : initial.state === 'ready'
        ? { ...initial, state: 'preparing' as const, page: null }
        : initial;
  const admitted = !!subject && classificationReadMatches(candidate, subject, locale, frontier);
  const feedback = state ?? (admitted ? candidate.state : 'preparing');
  const refresh = async (original: ClassificationFrontier) => {
    if (!current() || inFlight.current === visit || classificationAddressKey(original) !== address) return;
    inFlight.current = visit;
    setPending(visit);
    const unavailable: OwnClassificationsRead = {
      state: 'unavailable',
      subject,
      locale,
      frontier: original,
      page: null,
    };
    try {
      const value = await read(original, visit.abort.signal);
      if (current() && subject)
        update({ visit, value: classificationReadMatches(value, subject, locale, original) ? value : unavailable });
    } catch {
      if (current()) update({ visit, value: unavailable });
    } finally {
      if (inFlight.current === visit) inFlight.current = null;
      if (current()) setPending(null);
    }
  };
  useEffect(() => {
    if (!subject || state || !current() || started.current === visit) return;
    started.current = visit;
    void refresh(frontier);
  });
  return (
    <OwnClassificationsWorkspace
      state={state ?? (pending === visit ? 'preparing' : feedback)}
      page={admitted && candidate.state === 'ready' ? candidate.page : null}
      frontier={frontier}
      locale={locale}
      isCurrent={isCurrent}
      onNext={onNext}
      onRetry={refresh}
      commands={
        commands && candidate.state === 'ready' && admitted
          ? { ...commands, read: candidate, retire }
          : undefined
      }
    />
  );
}

/** Kept for callers presenting an unavailable response through the same admission lifecycle. */
export const UnavailableClassificationsReader = ClassificationsReader;
