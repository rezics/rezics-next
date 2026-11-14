import { useEffect, useRef, useState } from 'react';
import { useReaderCurrentOrigin } from '../../session/reader';
import { useReaderVisit } from '../../reader/lifetime';
import { getLocale } from '../../paraglide/runtime.js';
import { readPrivateInsights, type PrivateInsightsResult } from './server';
import type { InsightsRead } from './native';

const operations = ['progress_session.list'] as const;
export type InsightsReader = (year: number) => Promise<PrivateInsightsResult>;
const nativeReader: InsightsReader = (year) => readPrivateInsights({ data: { year } });
export type InsightsState = InsightsRead | { kind: 'loading' | 'changed' | 'signed-out' | 'invalid' };
type Reading = { result: InsightsState; current: () => boolean };

/** Payloads never enter Query cache, hydration, storage or a retained private page loader. */
export function useInsightsReading(year: number | undefined, reader: InsightsReader = nativeReader) {
  const locale = getLocale();
  const visit = useReaderVisit(`reading-insights:${year}`, locale, getLocale);
  const origin = useReaderCurrentOrigin(`reading-insights:${locale}:${year}`, operations, null,
    { lifetime: visit, isCurrent: visit.current });
  const source = useRef(reader);
  source.current = reader;
  const attempted = useRef(false);
  const generation = useRef(0);
  const [reading, setReading] = useState<Reading>();
  const live = useRef(false);
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; generation.current++; };
  }, []);

  function refresh() {
    if (year === undefined || !origin.hydrated || !origin.current(0) || !visit.current()) return;
    attempted.current = true;
    const request = ++generation.current;
    const subject = origin.subject;
    const current = () => live.current && generation.current === request && source.current === reader && origin.current(0) && visit.current();
    setReading({ result: { kind: 'loading' }, current });
    void reader(year).then((result) => {
      if (!current()) return;
      const received: InsightsState = result.kind === 'received'
        ? result.viewer === subject ? result.read : { kind: 'changed' }
        : { kind: result.kind };
      setReading({ result: received, current });
    });
  }

  useEffect(() => {
    // Wait for initial admission; a replaced source requires the owner's explicit refresh.
    if (!attempted.current && origin.hydrated && origin.allowed[0]) refresh();
  }, [origin.hydrated, origin.readKey(0), year]);

  const result: InsightsState = year === undefined ? { kind: 'invalid' }
    : origin.session.state === 'signed-out' ? { kind: 'signed-out' }
    : reading && reading.current() ? reading.result
    : attempted.current ? { kind: 'changed' }
    : origin.session.state === 'unavailable' ? { kind: 'unavailable' }
    : { kind: 'loading' };
  return { result, refresh, current: () => !!reading?.current(),
    canRefresh: origin.hydrated && origin.allowed[0] === true && visit.current() };
}
