import { useEffect, useRef } from 'react';
import { subjectViewHref } from '../../../subject/subject-href';
import { useSession } from '../../../session/query';
import type { Subject } from '../../../subject/types';
import { useOverview, viewHref } from '../../pages/overview';
import { literaryAuthorityKey, literaryReaderIdentity, literaryReaderRetired, type LiteraryReaderObservation } from './model';
import { LiteraryReader } from './view';

export function LiteraryReaderEntry({
  work,
  source,
  locale,
  context,
}: {
  work: Subject;
  source: object;
  locale: string;
  context?: string | null | undefined;
}) {
  const editionView = useOverview('editions');
  const overview = useOverview('');
  const state = editionView ?? overview;
  const session = useSession();
  const authority = literaryAuthorityKey(session);
  const current: LiteraryReaderObservation = {
    source,
    subject: work.id,
    locale,
    context: context ?? null,
    authority,
  };
  const observed = useRef<LiteraryReaderObservation | null>(null);
  const previous = observed.current;
  const sourceReplaced = previous === null || previous.source !== source || previous.subject !== work.id;
  if (sourceReplaced) observed.current = current;
  const captured = observed.current ?? current;
  const retired = !sourceReplaced && literaryReaderRetired(captured, current);

  useEffect(() => {
    if (observed.current?.source === source && observed.current.authority === null && authority !== null)
      observed.current = { ...observed.current, authority };
  }, [authority, source]);

  if (work.type !== 'schema:Book') return null;

  const value = state?.value;
  const matchingSource = value?.subject === work.id && (value.context?.id ?? null) === (context ?? null);
  const editionSection = editionView?.section;
  const editionHref =
    matchingSource && editionSection?.ok && editionSection.read.kind === 'links'
      ? viewHref(value, 'editions') ?? undefined
      : undefined;
  const factsHref = matchingSource
    ? viewHref(value, 'details') ?? undefined
    : subjectViewHref({ id: work.id, label: '' }, locale, 'details');

  return (
    <LiteraryReader
      identity={literaryWorkIdentity(work, locale)}
      locale={locale}
      {...(editionHref ? { editionHref } : {})}
      {...(factsHref ? { factsHref } : {})}
      retired={retired}
    />
  );
}

export { literaryWorkIdentity, literaryAuthorityKey, literaryReaderRetired } from './model';
