import { useLayoutEffect, useMemo, useRef } from 'react';
import type { SubjectRead } from '@rezics/client';
import { subjectHref } from '../../../subject/subject-href';
import { PlainLink, type PageLink } from '../../pages/shared';
import { catalogueEntries } from '../catalogue-entry';
import { peopleNames } from './model';
import { PeopleNamesView } from './view';
import { useNamesLifetime } from '../work-names/lifetime';
import { loadNamesAdvice, useNamesAdvice, type NamesAdviceLoader } from '../work-names/advice';
import { NamesHandoff, namesReturnHref } from '../work-names/navigation';
import { withSubjectVisitReturn } from '../../pages/subject-visit-navigation';

export type PeopleNamesReading = {
  public: SubjectRead; locale: string; link?: PageLink; release?: object; reader?: object;
};
export type { NamesAdviceLoader } from '../work-names/advice';

export function PeopleNamesEntry({ reading, adviceLoader = loadNamesAdvice }: {
  reading: PeopleNamesReading; adviceLoader?: NamesAdviceLoader;
}) {
  const { subject } = reading.public;
  const incarnation = useRef({ public: reading.public, release: reading.release, reader: reading.reader });
  const identity = useRef(0);
  if (incarnation.current.public !== reading.public || incarnation.current.release !== reading.release || incarnation.current.reader !== reading.reader) {
    incarnation.current = { public: reading.public, release: reading.release, reader: reading.reader };
    identity.current++;
  }
  const lifetime = useNamesLifetime(reading.public, JSON.stringify([subject.id, subject.context, reading.locale, identity.current]));
  const host = useRef<HTMLDivElement>(null);
  const focused = useRef<EventTarget | null>(null);
  useLayoutEffect(() => {
    if (focused.current instanceof Element && !focused.current.isConnected && document.activeElement === document.body)
      host.current?.querySelector<HTMLElement>('summary')?.focus();
  }, [lifetime.generation, lifetime.retired]);
  const names = useMemo(() => peopleNames(subject, reading.locale), [subject, reading.locale]);
  const address = { id: subject.id, label: names.state === 'ready' ? names.selected.text : '', locale: reading.locale };
  const href = subjectHref(address, reading.locale).href;
  return <div ref={host} className="min-w-0" onFocusCapture={event => { focused.current = event.target; }}>
    <NamesVisit key={lifetime.generation} {...{ names, reading, lifetime, adviceLoader, href }} termsHref={catalogueEntries.terms(address).href} />
  </div>;
}

function NamesVisit({ names, reading, lifetime, adviceLoader, href, termsHref }: {
  names: ReturnType<typeof peopleNames>; reading: PeopleNamesReading; lifetime: ReturnType<typeof useNamesLifetime>;
  adviceLoader: NamesAdviceLoader; href: string; termsHref: string;
}) {
  const advice = useNamesAdvice(lifetime.observation, lifetime.current, adviceLoader);
  const subject = reading.public.subject;
  const Link = reading.link ?? PlainLink;
  // The page link adapter applies the selected Realm; capture the final link address at activation.
  const returnHref = namesReturnHref(href, reading.locale);
  const binding = lifetime.caller ? JSON.stringify([subject.id, subject.context, reading.locale,
    Reflect.get(subject, 'release'), Reflect.get(subject, 'revision'), lifetime.caller]) : undefined;
  return <NamesHandoff {...{ binding, returnHref }} locale={reading.locale} current={lifetime.current}>
    {restored => <PeopleNamesView key={restored ? 'returned' : 'initial'} names={names} locale={reading.locale}
      retired={lifetime.retired} current={lifetime.current} {...advice} restored={restored}
      sourcesHref={`${href}/sources`} termsHref={withSubjectVisitReturn(termsHref, returnHref ?? '', reading.locale)} link={Link} />}
  </NamesHandoff>;
}
