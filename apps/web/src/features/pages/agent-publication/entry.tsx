import type { Related, Subject } from '../../../subject/types';
import { defaultReader, type Reader } from '../../../subject/reader';
import type { PageLink } from '../shared';
import { PublicationOverlayView } from '../publication-overlay';
import type { PublicationDefinitions } from '../subject-metadata';
import { agentOverlayReading } from './model';

/** Generic SoftwareApplication and agent pages project identity links from the current read. */
export function AgentPublicationEntry({
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
  const reading = agentOverlayReading(subject, definitions, locale, reader);
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
