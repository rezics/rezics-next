import type { Related, Subject, Summary } from '../../../subject/types';
import { defaultReader, type Reader } from '../../../subject/reader';
import type { PageLink } from '../shared';
import { PublicationOverlayView } from '../publication-overlay';
import type { PublicationDefinitions } from '../subject-metadata';
import { gameOverlayReading, gamePageInitial } from './model';

/** No extra read: overlay uses the current anonymous page's statements and related summaries. */
export function GamePublicationEntry({
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
  const reading = gameOverlayReading(subject, definitions, locale, reader);
  if (!reading) return null;
  return (
    <PublicationOverlayView
      reading={reading}
      subject={subject}
      related={related}
      locale={locale}
      {...(link ? { link } : {})}
    />
  );
}

export function gamePublicationInitial(
  subject: Subject,
  related: Related,
  summary: Summary | null | undefined,
  definitions: PublicationDefinitions | undefined,
  digest: string | undefined,
  locale: string,
  reader: Reader = defaultReader,
) {
  if (!definitions || !digest) return;
  return gamePageInitial(subject, related, summary, definitions, digest, locale, reader);
}
