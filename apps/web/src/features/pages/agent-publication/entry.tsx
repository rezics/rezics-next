import type { Related, Subject } from '../../../subject/types';
import { defaultReader, type Reader } from '../../../subject/reader';
import type { PageLink } from '../shared';
import type { PublicationDefinitions } from '../subject-metadata';
import { agentPublicationReading } from './model';
import { AgentPublicationView } from './view';

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
  definitions?: PublicationDefinitions;
  locale: string;
  reader?: Reader;
  link?: PageLink;
}) {
  if (!agentPublicationReading(subject, definitions, locale, reader)) return null;
  return (
    <AgentPublicationView
      subject={subject}
      related={related}
      definitions={definitions}
      locale={locale}
      reader={reader}
      {...(link ? { link } : {})}
    />
  );
}
