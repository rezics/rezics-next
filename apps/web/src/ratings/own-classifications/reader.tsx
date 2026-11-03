import { useEffect, useRef, useState } from 'react';
import type { OwnClassificationsRead } from './actions';
import { classificationAddressKey } from './inventory';
import { OwnClassificationsWorkspace } from './page';
import type { ClassificationFrontier, OwnClassificationsState } from './types';

export type OwnClassificationsReader = (frontier: ClassificationFrontier) => Promise<OwnClassificationsRead>;

/** Loader feedback cannot be borrowed by another account, locale or selected continuation. */
export function classificationReadMatches(
  read: OwnClassificationsRead,
  subject: string,
  locale: string,
  frontier: ClassificationFrontier,
): boolean {
  return (
    (read.subject === subject || (read.state === 'signed-out' && read.subject === null)) &&
    read.locale === locale &&
    classificationAddressKey(read.frontier) === classificationAddressKey(frontier)
  );
}

/** The unpublished protocol stays unavailable, with the same private lifetime as a future native reader. */
export function UnavailableClassificationsReader({
  initial,
  frontier,
  locale,
  subject,
  state,
  isCurrent,
  read,
}: {
  initial: OwnClassificationsRead;
  frontier: ClassificationFrontier;
  locale: string;
  subject: string | null;
  state: OwnClassificationsState | null;
  isCurrent: () => boolean;
  read: OwnClassificationsReader;
}) {
  const latest = useRef({ subject, locale, address: classificationAddressKey(frontier), initial, active: true });
  const address = classificationAddressKey(frontier);
  if (
    latest.current.subject !== subject ||
    latest.current.locale !== locale ||
    latest.current.address !== address ||
    latest.current.initial !== initial
  ) {
    latest.current.active = false;
    latest.current = { subject, locale, address, initial, active: true };
  }
  const visit = latest.current;
  const [result, update] = useState<{ visit: object; value: OwnClassificationsRead } | null>(null);
  const [pending, setPending] = useState<object | null>(null);
  const mounted = useRef(false);
  const inFlight = useRef<object | null>(null);
  const started = useRef<object | null>(null);
  const current = () => mounted.current && latest.current === visit && visit.active && isCurrent();
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, [visit]);
  const candidate = result?.visit === visit ? result.value : initial;
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
      const value = await read(original);
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
      page={null}
      frontier={frontier}
      locale={locale}
      isCurrent={isCurrent}
      onNext={() => {}}
      onRetry={refresh}
    />
  );
}
