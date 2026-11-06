import type { Related, Subject, Summary } from '../../../subject/types';
import { defaultReader, type Reader } from '../../../subject/reader';
import type { PageLink } from '../shared';
import type { PublicationDefinitions } from '../subject-metadata';
import { gamePageInitial, gamePublicationReading } from './model';
import { GamePublicationView } from './view';

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
  definitions?: PublicationDefinitions;
  locale: string;
  reader?: Reader;
  link?: PageLink;
}) {
  if (!gamePublicationReading(subject, definitions, locale, reader)) return null;
  return (
    <GamePublicationView
      subject={subject}
      related={related}
      definitions={definitions}
      locale={locale}
      reader={reader}
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
