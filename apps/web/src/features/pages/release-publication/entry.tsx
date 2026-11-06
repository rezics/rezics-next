import type { Related, Subject } from '../../../subject/types';
import { defaultReader, type Reader } from '../../../subject/reader';
import type { PageLink } from '../shared';
import { PublicationOverlayView } from '../publication-overlay';
import type { PublicationDefinitions } from '../subject-metadata';
import { releasePublicationReading } from './model';

/** No extra read: overlay uses the current anonymous page's statements and related summaries. */
export function ReleasePublicationEntry({
  subject,
  related,
  definitions,
  locale,
  reader = defaultReader,
  link,
}: {
  subject: Subject;
  related: Related;
  definitions?: PublicationDefinitions | undefined;
  locale: string;
  reader?: Reader;
  link?: PageLink | undefined;
}) {
  const reading = releasePublicationReading(subject, definitions, locale, reader);
  if (!reading) return null;
  return (
    <PublicationOverlayView
      reading={{ kind: 'release', fields: reading.fields }}
      subject={subject}
      related={related}
      locale={locale}
      {...(link ? { link } : {})}
    />
  );
}
