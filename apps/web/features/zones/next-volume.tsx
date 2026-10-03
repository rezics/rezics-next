'use client';

import { resourceHref } from '../address/path.ts';
import type { ZoneWork } from '@rezics/zone-sdk';
import { useEffect, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { useReaderActions } from '../catalogue/reader-actions.tsx';
import LocalizedLink from '../shell/localized-link.tsx';
import { languageName } from '../tracking/display.ts';
import { copyOf } from '../tracking/messages.ts';
import { reasonText } from '../tracking/series-progress-panel.tsx';
import type { TrackingApi } from '../tracking/api.ts';
import type { SeriesSummary } from '../tracking/types.ts';

// The next volume of a series as Main reports it for the signed-in reader, in the language they
// chose (their edition preference, else the interface language). Nothing is computed here: the next
// part, whether it has text in that language and why it is next are Main's progress summary. Signed
// out, or for a Work that is not a series, these draw nothing.

interface Reading {
  language: string;
  series: SeriesSummary;
}

/**
 * One read per Work per page, shared by every card and the shelf. Main answers a series' progress one Work
 * at a time, in the language of the reader's edition choice (the `language` given only stands where there is
 * none), so the cards of a page would otherwise each ask again. The first `MAX_READS` Works a page asks about
 * are read, four at a time; the rest show no line, which keeps a page far under a reader's request limits.
 */
export const MAX_READS = 12;
const CONCURRENCY = 4;
const FRESH_MS = 30_000;

interface Store {
  readings: Map<string, { at: number; read: Promise<Reading | null> }>;
  waiting: (() => void)[];
  running: number;
}
const stores = new WeakMap<TrackingApi, Map<string, Store>>();

function storeOf(api: TrackingApi, locale: string): Store {
  const byLocale = stores.get(api) ?? new Map<string, Store>();
  stores.set(api, byLocale);
  const store = byLocale.get(locale) ?? { readings: new Map(), waiting: [], running: 0 };
  byLocale.set(locale, store);
  return store;
}

/** The reader's progress through a Work, read at most once per page; null when it is no series, has no next part or is over the cap. */
export function readingOf(
  api: TrackingApi,
  work: string,
  locale: UiLocale,
): Promise<Reading | null> {
  const store = storeOf(api, locale);
  const known = store.readings.get(work);
  // A reading is a page's: one the reader may have changed since (finishing a volume elsewhere) is read again.
  if (known && Date.now() - known.at < FRESH_MS) return known.read;
  if (known) store.readings.delete(work);
  if (store.readings.size >= MAX_READS) return Promise.resolve(null);
  const read = (async () => {
    while (store.running >= CONCURRENCY)
      await new Promise<void>((resume) => store.waiting.push(resume));
    store.running += 1;
    try {
      const answer = await api.series(work, locale);
      return answer.ok && answer.data.scope === 'disclosed-composition'
        ? { language: answer.data.language ?? locale, series: answer.data }
        : null;
    } finally {
      store.running -= 1;
      store.waiting.shift()?.();
    }
  })();
  store.readings.set(work, { at: Date.now(), read });
  return read;
}

function useReadings(works: readonly string[], locale: UiLocale): ReadonlyMap<string, Reading> {
  const actions = useReaderActions();
  const api = actions.kind === 'ready' ? (actions.tracking ?? null) : null;
  const [found, setFound] = useState<ReadonlyMap<string, Reading>>(new Map());
  const key = works.join(' ');
  useEffect(() => {
    if (!api) return;
    let current = true;
    void Promise.all(
      works.map(async (work): Promise<[string, Reading] | null> => {
        const reading = await readingOf(api, work, locale);
        return reading ? [work, reading] : null;
      }),
    ).then((items) => {
      if (current) setFound(new Map(items.filter((item) => item !== null)));
    });
    return () => {
      current = false;
    };
    // `key` stands for the list: a new array of the same Works is not a new read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, key, locale]);
  return found;
}

function NextLine({ reading, locale }: { reading: Reading; locale: UiLocale }) {
  const t = copyOf(locale);
  const next = reading.series.next;
  if (!next) return null;
  return (
    <p data-next-volume="" data-available={String(next.part.available)} className="text-sm">
      <span className="font-medium">{t.nextPart}: </span>
      <LocalizedLink
        href={resourceHref('/w/', next.part.work)}
        className="rounded-sm font-medium text-primary underline-offset-4
      outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
      >
        {next.part.displayLabel || t.unnamedPart}
      </LocalizedLink>
      <span className="text-muted-foreground">
        {' '}
        · {languageName(reading.language, locale)} · {reasonText(next.reason, t)}
      </span>
    </p>
  );
}

/** The next volume of one series, as a line under its card. */
export function NextVolume({ work, locale }: { work: string; locale: UiLocale }) {
  const reading = useReadings([work], locale).get(work);
  return reading ? <NextLine reading={reading} locale={locale} /> : null;
}

/**
 * "Continue your series": the series the reader has started, each with its next volume. Series the
 * reader has not started are left out; with none, nothing is drawn.
 */
export function NextVolumeShelf({
  works,
  heading,
  locale,
}: {
  works: readonly Pick<ZoneWork, 'id' | 'href' | 'title'>[];
  heading: string;
  locale: UiLocale;
}) {
  const readings = useReadings(
    works.map((work) => work.id),
    locale,
  );
  const started = works.flatMap((work) => {
    const reading = readings.get(work.id);
    return reading?.series.next && reading.series.counts.completed > 0 ? [{ work, reading }] : [];
  });
  if (!started.length) return null;
  return (
    <section aria-label={heading} data-next-volume-shelf="" className="grid gap-3">
      <h2 className="font-semibold text-lg">{heading}</h2>
      <ul className="grid gap-3">
        {started.map(({ work, reading }) => (
          <li key={work.id} className="grid gap-1 rounded-xl border border-border/60 bg-card p-3">
            <LocalizedLink
              href={work.href}
              lang={work.title?.lang}
              dir={work.title?.dir}
              className="w-fit rounded-sm font-medium font-work-title outline-none hover:underline focus-visible:ring-2
            focus-visible:ring-ring"
            >
              {work.title?.value}
            </LocalizedLink>
            <NextLine reading={reading} locale={locale} />
          </li>
        ))}
      </ul>
    </section>
  );
}
