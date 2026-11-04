import { QueryClientContext } from '@tanstack/react-query';
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { SubjectRead } from '@rezics/client';
import { browserObservation, type BrowserObservationSnapshot } from '../../../session/observation';
import { useCatalogueLifetime } from '../../../subject/candidate-lifetime';
import { subjectHref } from '../../../subject/subject-href';
import { PlainLink, type PageLink } from '../../pages/shared';
import { catalogueEntries } from '../catalogue-entry';
import type { TermsPageAuthority } from '../subject-terms';
import { peopleNames, peopleNamesAdvice, type NamesAdvice } from './model';
import { PeopleNamesView } from './view';

const unknown: BrowserObservationSnapshot = { state: 'unknown' };
const unobserved = { subscribe: () => () => {}, getSnapshot: () => unknown, getServerSnapshot: () => unknown };
export type PeopleNamesReading = {
  public: SubjectRead;
  locale: string;
  link?: PageLink;
  release?: object;
  reader?: object;
};
export type NamesAdviceLoader = (reader: string) => Promise<TermsPageAuthority>;
const loadAdvice: NamesAdviceLoader = async (reader) => {
  const { readCatalogueTermsAuthority } = await import('../subject-terms-actions');
  return readCatalogueTermsAuthority({ data: { expectedReader: reader } });
};

/** One public projection and optional bounded Terms advice; never a Subject reread or per-language request. */
export function PeopleNamesEntry({
  reading,
  adviceLoader = loadAdvice,
}: {
  reading: PeopleNamesReading;
  adviceLoader?: NamesAdviceLoader;
}) {
  const { subject } = reading.public;
  const client = useContext(QueryClientContext);
  const store = client ? browserObservation(client) : unobserved;
  const observation = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  const source = useRef({ subject, release: reading.release, reader: reading.reader, generation: 0 });
  if (
    source.current.subject !== subject ||
    source.current.release !== reading.release ||
    source.current.reader !== reading.reader
  )
    source.current = {
      subject,
      release: reading.release,
      reader: reading.reader,
      generation: source.current.generation + 1,
    };
  const work = useCatalogueLifetime(
    JSON.stringify([
      'people-names',
      subject.id,
      subject.type,
      subject.context,
      reading.locale,
      source.current.generation,
    ]),
  );
  const seen = useRef({ observation, work, retired: false });
  if (seen.current.work !== work) seen.current = { observation, work, retired: false };
  else if (seen.current.observation !== observation) {
    // Initial cache observation may become known; subsequent changes require a replacement page source.
    if (seen.current.observation.state !== 'unknown') seen.current.retired = true;
    seen.current.observation = observation;
  }
  const bound = seen.current;
  const current = () => work.active() && !bound.retired && store.getSnapshot() === observation;
  const host = useRef<HTMLDivElement>(null);
  const focused = useRef<EventTarget | null>(null);
  useLayoutEffect(() => {
    if (focused.current instanceof Element && !focused.current.isConnected && document.activeElement === document.body)
      host.current?.querySelector<HTMLElement>('summary')?.focus();
  }, [work.generation, bound.retired]);
  const names = useMemo(() => peopleNames(subject, reading.locale), [subject, reading.locale]);
  const address = { id: subject.id, label: names.state === 'ready' ? names.selected.text : '', locale: reading.locale };
  return (
    <div
      ref={host}
      className="min-w-0"
      onFocusCapture={(event) => {
        focused.current = event.target;
      }}
    >
      <NamesVisit
        key={work.generation}
        names={names}
        locale={reading.locale}
        retired={bound.retired}
        current={current}
        observation={observation}
        adviceLoader={adviceLoader}
        sourcesHref={`${subjectHref(address, reading.locale).href}/sources`}
        termsHref={catalogueEntries.terms(address).href}
        link={reading.link ?? PlainLink}
      />
    </div>
  );
}

function NamesVisit({
  observation,
  adviceLoader,
  current,
  ...props
}: Omit<Parameters<typeof PeopleNamesView>[0], 'advice' | 'retryAdvice' | 'current'> & {
  current: () => boolean;
  observation: BrowserObservationSnapshot;
  adviceLoader: NamesAdviceLoader;
}) {
  const [advice, setAdvice] = useState<NamesAdvice>('unavailable');
  const [attempt, setAttempt] = useState(0);
  const inFlight = useRef(false);
  const latest = useRef(current);
  latest.current = current;
  useEffect(() => {
    if (observation.state !== 'signed-in' || !latest.current()) return;
    let active = true;
    inFlight.current = true;
    setAdvice('pending');
    void adviceLoader(observation.observation.subject)
      .then(
        (result) => {
          if (active && latest.current()) setAdvice(peopleNamesAdvice(result));
        },
        () => {
          if (active && latest.current()) setAdvice('unavailable');
        },
      )
      .finally(() => {
        if (active) inFlight.current = false;
      });
    return () => {
      active = false;
      inFlight.current = false;
    };
  }, [observation, adviceLoader, attempt]);
  return (
    <PeopleNamesView
      {...props}
      current={current}
      advice={
        observation.state === 'signed-out' ? 'signed-out' : observation.state !== 'signed-in' ? 'unavailable' : advice
      }
      retryAdvice={
        observation.state === 'signed-in'
          ? () => {
              if (!inFlight.current && current()) setAttempt((value) => value + 1);
            }
          : undefined
      }
    />
  );
}
