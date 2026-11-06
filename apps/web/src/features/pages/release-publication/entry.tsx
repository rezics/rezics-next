import type { Related, Subject } from '../../../subject/types';
import { defaultReader, type Reader } from '../../../subject/reader';
import type { PageLink } from '../shared';
import type { PublicationDefinitions } from '../subject-metadata';
import { releasePublicationReading } from './model';
import { ReleasePublicationView } from './view';

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
  definitions?: PublicationDefinitions;
  locale: string;
  reader?: Reader;
  link?: PageLink;
}) {
  const reading = releasePublicationReading(subject, definitions, locale, reader);
  if (!reading) return null;
  return (
    <ReleasePublicationView
      reading={reading}
      subject={subject}
      related={related}
      locale={locale}
      reader={reader}
      {...(link ? { link } : {})}
    />
  );
}
