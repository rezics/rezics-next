import { useMemo } from 'react';
import type { Release } from '@rezics/definitions';
import type { Related, Subject } from '../../../subject/types';
import { projectWorkTags } from './model';
import { WorkTagReadingView } from './view';

export function WorkTagReading({
  subject,
  related,
  definitions,
  locale,
  spoilerThreshold,
}: {
  subject: Subject;
  related: Related;
  definitions: Pick<Release, 'types' | 'properties'>;
  locale: string;
  spoilerThreshold: number;
}) {
  const model = useMemo(
    () => projectWorkTags({ subject, related, definitions, locale, spoilerThreshold }),
    [subject, related, definitions, locale, spoilerThreshold],
  );
  if (!model) return null;
  return (
    <WorkTagReadingView
      key={model.sourceKey}
      model={model}
      related={related}
      definitions={definitions}
      locale={locale}
      spoilerThreshold={spoilerThreshold}
    />
  );
}
