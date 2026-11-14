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
  onReturnReveal,
}: {
  reading: PeopleNamesReading;
  adviceLoader?: NamesAdviceLoader;
  onReturnReveal?: ((token: string | undefined) => void) | undefined;
}) {
  const { subject } = reading.public;
  // Supplied names do not depend on display preferences. PeopleFacts owns their profile disclosure boundary.
  const incarnation = useRef({ public: reading.public, release: reading.release });
  const identity = useRef(0);
  if (incarnation.current.public !== reading.public || incarnation.current.release !== reading.release) {
    incarnation.current = { public: reading.public, release: reading.release };
    identity.current++;
  }
  const lifetime = useNamesLifetime(
    reading.public,
    JSON.stringify([
      subject.id,
      subject.type,
      subject.context,
      subject.release,
      subject.revision,
      reading.locale,
      identity.current,
    ]),
  );
  const host = useRef<HTMLDivElement>(null);
  const focused = useRef<EventTarget | null>(null);
  useLayoutEffect(() => {
    if (
      focused.current instanceof Element &&
      !focused.current.isConnected &&
      document.activeElement === document.body
    ) {
      let target = host.current?.querySelector<HTMLElement>('summary');
      // A retired row may have belonged to a profile the visitor has since collapsed.
      for (let parent = target?.parentElement; parent; parent = parent.parentElement)
        if (parent.tagName === 'DETAILS' && !(parent as HTMLDetailsElement).open && parent.firstElementChild !== target)
          target = parent.querySelector<HTMLElement>(':scope > summary') ?? undefined;
      if (target?.isConnected) target.focus();
    }
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
        {...{ names, reading, lifetime, adviceLoader, address, onReturnReveal }}
      />
    </div>
  );
}
