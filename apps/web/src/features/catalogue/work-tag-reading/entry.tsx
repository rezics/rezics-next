import { useMemo } from 'react';
import type { Release } from '@rezics/definitions';
import type { Related, Subject } from '../../../subject/types';
import { contextHref } from '../../pages/context-navigation';
import { workTagReturnHref } from '../../pages/subject-visit-navigation';
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
  if (!model) return null;
  const workHref = currentHref ?? (realm ? contextHref(model.workHref, realm) : model.workHref);
  const returnFor = returnToFor ?? ((selection: WorkTagReturnSelection) =>
    workTagReturnHref(currentHref, workHref, locale, selection));
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
    />
  );
}
