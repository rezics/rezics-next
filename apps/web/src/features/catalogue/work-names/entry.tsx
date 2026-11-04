import { useMemo } from 'react';
import type { Release } from '@rezics/definitions';
import type { Subject } from '../../../subject/types';
import type { TermsPageAuthority } from '../subject-terms';
import { PlainLink, type PageLink } from '../../pages/shared';
import { subjectHref } from '../../../subject/subject-href';
import { workNames, supportsReleasedWorkNames } from './model';
import { WorkNamesView } from './view';
import { useNamesLifetime } from './lifetime';
import { loadNamesAdvice, useNamesAdvice, type NamesAdviceLoader } from './advice';
import { NamesHandoff, namesReturnHref } from './navigation';
import { withSubjectVisitReturn } from '../../pages/subject-visit-navigation';

/** The page owns public disclosure and the current release; Terms owns all edit payloads and recovery. */
export function WorkNamesEntry({ subject, source, locale, context, sourcesHref, release, releaseDigest,
  termsAuthority, expectedReader, adviceLoader = loadNamesAdvice, link: Link = PlainLink,
}: {
  subject: Subject; ancestors?: readonly string[] | undefined; source: object; locale: string;
  context: string | null; sourcesHref: string; release?: Pick<Release, 'types'> | undefined;
  releaseDigest?: string | undefined; termsAuthority?: TermsPageAuthority | undefined;
  expectedReader?: string | null | undefined; adviceLoader?: NamesAdviceLoader; link?: PageLink;
}) {
  const lifetime = useNamesLifetime(source, JSON.stringify([subject.id, subject.type, Reflect.get(subject, 'revision'), subject.context, context, locale, releaseDigest]), expectedReader);
  const names = useMemo(() => workNames(subject, locale), [subject, source, locale]);
  if (!supportsReleasedWorkNames(subject.type, release)) return null;
  const address = subjectHref({ id: subject.id, label: names.state === 'ready' ? names.selected.text : '' }, locale).href;
  // The existing Sources address carries the actual selected Realm.
  const url = new URL(sourcesHref, 'https://rezics.invalid');
  url.pathname = address;
  const returnHref = namesReturnHref(`${url.pathname}${url.search}`, locale);
  const binding = lifetime.caller ? JSON.stringify([subject.id, subject.context, context, locale, releaseDigest,
    Reflect.get(subject, 'revision'), lifetime.caller, returnHref]) : undefined;
  const termsHref = withSubjectVisitReturn(`${address}/terms${url.search}`, returnHref ?? '', locale);
  return <WorkNamesVisit key={lifetime.generation} {...{ names, locale, sourcesHref, termsHref, returnHref, binding,
    termsAuthority, adviceLoader, lifetime, Link }} />;
}

function WorkNamesVisit({ names, locale, sourcesHref, termsHref, returnHref, binding, termsAuthority, adviceLoader, lifetime, Link }: {
  names: ReturnType<typeof workNames>; locale: string; sourcesHref: string; termsHref: string;
  returnHref: string | undefined; binding: string | undefined; termsAuthority: TermsPageAuthority | undefined;
  adviceLoader: NamesAdviceLoader; lifetime: ReturnType<typeof useNamesLifetime>; Link: PageLink;
}) {
  const advice = useNamesAdvice(lifetime.observation, lifetime.current, adviceLoader, termsAuthority);
  return <NamesHandoff {...{ binding, returnHref, locale }} current={lifetime.current}>
    {restored => <WorkNamesView key={restored ? 'returned' : 'initial'} {...{ names, locale, sourcesHref, termsHref, restored }}
      retired={lifetime.retired} current={lifetime.current} {...advice} link={Link} />}
  </NamesHandoff>;
}
