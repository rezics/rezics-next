import type { Subject } from '../../../subject/types';
import type { Reader } from '../../../subject/reader';
import { defaultReader } from '../../../subject/reader';
import { pageText } from '../shared';
import {
  RELEASE_PUBLICATION_PROPERTIES,
  publicationOverlayKind,
  subjectPublicationFields,
  type PublicationDefinitions,
  type PublicationField,
} from '../subject-metadata';

export type ReleasePublicationField = PublicationField & {
  label: ReturnType<typeof pageText>;
};

export type ReleasePublicationReading = {
  type: 'wd:Q20631656';
  fields: ReleasePublicationField[];
};

const RELEASE_PROPERTY_SET = new Set<string>(RELEASE_PUBLICATION_PROPERTIES);

/** Project platform, date and language from the current software-release page. */
export function releasePublicationReading(
  subject: Subject,
  definitions: PublicationDefinitions | undefined,
  locale: string,
  reader: Reader = defaultReader,
): ReleasePublicationReading | undefined {
  if (publicationOverlayKind(subject.type, definitions) !== 'release') return;
  const fields = subjectPublicationFields(subject, definitions, reader, locale).flatMap((field) => {
    if (!RELEASE_PROPERTY_SET.has(field.property)) return [];
    const label = pageText(definitions?.properties[field.property]?.labels, locale);
    return [{ ...field, label }];
  });
  return fields.length ? { type: 'wd:Q20631656', fields } : undefined;
}
