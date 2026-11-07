import { useMemo, useRef } from 'react';
import type { Release } from '@rezics/definitions';
import type { Related, Subject } from '../../../subject/read-contract';
import { contextHref } from '../../pages/context-navigation';
import { subjectVisitReturn, workTagReturn, workTagReturnHref } from '../../pages/subject-visit-navigation';
import { projectWorkTags } from './model';
import { WorkTagReadingView } from './view';

export type WorkTagReturnSelection = Readonly<{
  property: string;
  statement: string;
  spoiler: 0 | 1 | 2;
  focus: 'browse' | 'evidence';
}>;

export function WorkTagReading({
  subject,
  related,
  definitions,
  locale,
  spoilerThreshold,
  currentHref,
  realm,
  returnToFor,
}: {
  subject: Subject;
  related: Related;
  definitions?: Pick<Release, 'types' | 'properties'> | undefined;
  locale: string;
  spoilerThreshold: number;
  currentHref?: string | undefined;
  realm?: string | undefined;
  returnToFor?: ((selection: WorkTagReturnSelection) => string) | undefined;
}) {
  const model = useMemo(
    () => projectWorkTags({ subject, related, definitions, locale, spoilerThreshold, currentHref, realm }),
    [subject, related, definitions, locale, spoilerThreshold, currentHref, realm],
  );
  const visit = useRef({ href: currentHref, source: model?.sourceKey, consumed: false });
  if (visit.current.href !== currentHref)
    visit.current = { href: currentHref, source: model?.sourceKey, consumed: false };
  else if (visit.current.source !== model?.sourceKey) visit.current.consumed = true;
  if (!model) return null;
  const workHref = currentHref ?? (realm ? contextHref(model.workHref, realm) : model.workHref);
  const accepted = subjectVisitReturn(currentHref, locale);
  const address = accepted ? new URL(accepted, 'https://rezics.invalid') : undefined;
  const selection = address ? workTagReturn(address.hash) : undefined;
  const returning =
    !visit.current.consumed &&
    address?.pathname.split('/')[3] === subject.id &&
    (address.searchParams.get('realm') ?? undefined) === realm &&
    (address.hash === '#work-tags' || selection !== undefined);
  const returnIntent = returning
    ? {
        selection,
        consume: () => {
          visit.current.consumed = true;
        },
      }
    : undefined;
  const returnFor =
    returnToFor ?? ((selection: WorkTagReturnSelection) => workTagReturnHref(currentHref, workHref, locale, selection));
  return (
    <WorkTagReadingView
      key={model.sourceKey}
      model={model}
      related={related}
      definitions={definitions}
      locale={locale}
      spoilerThreshold={spoilerThreshold}
      workHref={workHref}
      returnToFor={returnFor}
      returnIntent={returnIntent}
    />
  );
}
