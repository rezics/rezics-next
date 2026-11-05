import { useLayoutEffect, useMemo, useRef } from 'react';
import type { SubjectRead } from '@rezics/client';
import type { PageLink } from '../../pages/shared';
import { peopleNames } from './model';
import { PeopleNamesVisit } from './visit';
import { peopleNamesAddress } from './navigation';
import { useNamesLifetime } from '../work-names/lifetime';
import { loadNamesAdvice, type NamesAdviceLoader } from '../work-names/advice';

export type PeopleNamesReading = {
  public: SubjectRead;
  locale: string;
  link?: PageLink;
  release?: object;
  reader?: object;
};
export type { NamesAdviceLoader } from '../work-names/advice';

export function PeopleNamesEntry({
  reading,
  adviceLoader = loadNamesAdvice,
}: {
  reading: PeopleNamesReading;
  adviceLoader?: NamesAdviceLoader;
}) {
  const { subject } = reading.public;
  const incarnation = useRef({ public: reading.public, release: reading.release, reader: reading.reader });
  const identity = useRef(0);
  if (
    incarnation.current.public !== reading.public ||
    incarnation.current.release !== reading.release ||
    incarnation.current.reader !== reading.reader
  ) {
    incarnation.current = { public: reading.public, release: reading.release, reader: reading.reader };
    identity.current++;
  }
  const lifetime = useNamesLifetime(
    reading.public,
    JSON.stringify([subject.id, subject.type, subject.context, subject.release, subject.revision, reading.locale, identity.current]),
  );
  const host = useRef<HTMLDivElement>(null);
  const focused = useRef<EventTarget | null>(null);
  useLayoutEffect(() => {
    if (focused.current instanceof Element && !focused.current.isConnected && document.activeElement === document.body)
      host.current?.querySelector<HTMLElement>('summary')?.focus();
  }, [lifetime.generation, lifetime.retired]);
  const names = useMemo(() => peopleNames(subject, reading.locale), [subject, reading.locale]);
  const address = peopleNamesAddress(subject, names, reading.locale);
  return (
    <div
      ref={host}
      className="min-w-0"
      onFocusCapture={(event) => {
        focused.current = event.target;
      }}
    >
      <PeopleNamesVisit
        key={lifetime.generation}
        {...{ names, reading, lifetime, adviceLoader, address }}
      />
    </div>
  );
}

