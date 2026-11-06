import type { Subject } from '../../../subject/types';
import type { Reader } from '../../../subject/reader';
import { defaultReader } from '../../../subject/reader';
import { pageText } from '../shared';
import {
  AGENT_PUBLICATION_PROPERTIES,
  publicationOverlayKind,
  publicationOverlayReading,
  subjectPublicationFields,
  type PublicationDefinitions,
  type PublicationField,
} from '../subject-metadata';

export type AgentPublicationField = PublicationField & {
  label: ReturnType<typeof pageText>;
};

export type AgentPublicationReading = {
  type: 'schema:Person' | 'schema:Organization' | 'schema:SoftwareApplication';
  fields: AgentPublicationField[];
};

const AGENT_PROPERTY_SET = new Set<string>(AGENT_PUBLICATION_PROPERTIES);

/** Project sameAs and url from the current anonymous agent page. */
export function agentPublicationReading(
  subject: Subject,
  definitions: PublicationDefinitions | undefined,
  locale: string,
  reader: Reader = defaultReader,
): AgentPublicationReading | undefined {
  if (publicationOverlayKind(subject.type, definitions) !== 'agent') return;
  const fields = subjectPublicationFields(subject, definitions, reader, locale).flatMap((field) => {
    if (!AGENT_PROPERTY_SET.has(field.property)) return [];
    return [{ ...field, label: pageText(definitions?.properties[field.property]?.labels, locale) }];
  });
  if (!fields.length) return;
  const type =
    subject.type === 'schema:Organization' ||
    subject.type === 'schema:SoftwareApplication' ||
    subject.type === 'schema:Person'
      ? subject.type
      : 'schema:SoftwareApplication';
  return { type, fields };
}

export function agentOverlayReading(
  subject: Subject,
  definitions: PublicationDefinitions | undefined,
  locale: string,
  reader: Reader = defaultReader,
) {
  return publicationOverlayReading(subject, definitions, locale, 'agent', reader);
}
