import type { Related, Subject } from '../../../subject/types';
import type { Reader } from '../../../subject/reader';
import type { PageLink } from '../shared';
import { PublicationOverlayView } from '../publication-overlay';
import { gameOverlayReading } from './model';
import type { PublicationDefinitions } from '../subject-metadata';

export function GamePublicationView({
  subject,
  related,
  definitions,
  locale,
  reader,
  link,
}: {
  subject: Subject;
  related: Related;
  definitions?: PublicationDefinitions;
  locale: string;
  reader?: Reader;
  link?: PageLink;
}) {
  const reading = gameOverlayReading(subject, definitions, locale, reader);
  if (!reading) return null;
  return (
    <PublicationOverlayView
      reading={reading}
      subject={subject}
      related={related}
      locale={locale}
      reader={reader}
      {...(link ? { link } : {})}
    />
  );
}
