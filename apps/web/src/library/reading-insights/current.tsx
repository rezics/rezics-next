import { useEffect, useRef, useState } from 'react';
import { useOperationAdmission, useReaderCurrentOrigin, useReaderResponseOrigin } from '../../session/reader';
import { useReaderVisit } from '../../reader/lifetime';
import { browserObservation } from '../../session';
import { viewerExposureQuery } from '../../kernel/viewer-exposure';
import { getLocale } from '../../paraglide/runtime.js';
import type { PrivateInsightsResult } from './server';
import type { InsightsRead } from './native';

const operations = ['progress_session.list'] as const;
export type InsightsReader = (year: number) => Promise<PrivateInsightsResult>;
const nativeReader: InsightsReader = async (year) => {
  const { readPrivateInsights } = await import('./server');
  return readPrivateInsights({ data: { year } });
};
export type InsightsState = InsightsRead | { kind: 'loading' | 'changed' | 'signed-out' | 'invalid' };
type Reading = { result: InsightsState; current: () => boolean; error?: unknown };

/** Payloads never enter Query cache, hydration, storage or a retained private page loader. */
export function useInsightsReading(year: number | undefined, reader: InsightsReader = nativeReader) {
  const locale = getLocale();
  const visit = useReaderVisit(`reading-insights:${year}`, locale, getLocale);
  const origin = useReaderCurrentOrigin(`reading-insights:${locale}:${year}`, operations, null, {
    lifetime: visit,
    isCurrent: visit.current,
  });
  const admission = useOperationAdmission('progress_session.list');
  const observation = browserObservation(origin.client).getSnapshot();
  const exposureKey = viewerExposureQuery(
    observation.state === 'signed-in' ? observation.observation : undefined,
  ).queryKey;
  const exposureCurrent = useReaderResponseOrigin(origin.client, exposureKey, () => true);
  const source = useRef({ reader, version: 0 });
  if (source.current.reader !== reader) source.current = { reader, version: source.current.version + 1 };
  const sourceVersion = source.current.version;
  const attempted = useRef(false);
  const generation = useRef(0);
  const [reading, setReading] = useState<Reading>();
  const live = useRef(false);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      generation.current++;
    };
  }, []);

  function refresh() {
    if (
      year === undefined ||
      !origin.hydrated ||
      source.current.version !== sourceVersion ||
      !origin.current(0) ||
      !exposureCurrent() ||
      !visit.current()
    )
      return;
    attempted.current = true;
    const request = ++generation.current;
    const subject = origin.subject;
    const version = sourceVersion;
    const current = () =>
      live.current &&
      generation.current === request &&
      source.current.version === version &&
      origin.current(0) &&
      exposureCurrent() &&
      visit.current();
    setReading({ result: { kind: 'loading' }, current });
    void reader(year).then(
      (result) => {
        if (!current()) return;
        const received: InsightsState =
          result.kind === 'received'
            ? result.viewer === subject
              ? result.read
              : { kind: 'changed' }
            : { kind: result.kind };
        setReading({ result: received, current });
      },
      (error: unknown) => {
        // Unexpected failures belong to the route error boundary; a retired request has no effect.
        if (current()) setReading({ result: { kind: 'unavailable' }, current, error });
      },
    );
  }

  useEffect(() => {
    // Wait for initial admission; a replaced source requires the owner's explicit refresh.
    if (!attempted.current && origin.hydrated && origin.allowed[0]) refresh();
  }, [origin.hydrated, origin.readKey(0), exposureCurrent, year]);

  if (reading?.current() && reading.error !== undefined) throw reading.error;
  const result: InsightsState =
    year === undefined
      ? { kind: 'invalid' }
      : origin.session.state === 'signed-out'
        ? { kind: 'signed-out' }
        : reading && reading.current()
          ? reading.result
          : attempted.current
            ? { kind: 'changed' }
            : origin.session.state === 'unavailable' || admission === 'unavailable'
              ? { kind: 'unavailable' }
              : admission === 'denied'
                ? { kind: 'denied' }
                : { kind: 'loading' };
  return {
    result,
    refresh,
    current: () => !!reading?.current(),
    canRefresh: origin.hydrated && origin.allowed[0] === true && exposureCurrent() && visit.current(),
  };
}
