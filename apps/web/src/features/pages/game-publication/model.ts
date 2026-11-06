import type { Reader } from '../../../subject/reader';
import { defaultReader } from '../../../subject/reader';
import { pageText, type Subject } from '../shared';
import {
  GAME_PUBLICATION_PROPERTIES,
  publicationOverlayKind,
  publicationOverlayReading,
  subjectPublicationFields,
  type PublicationDefinitions,
  type PublicationField,
} from '../subject-metadata';

export type GamePublicationField = PublicationField & {
  label: ReturnType<typeof pageText>;
};

export type GamePublicationReading = {
  type: 'schema:VideoGame';
  fields: GamePublicationField[];
};

const GAME_PROPERTY_SET = new Set<string>(GAME_PUBLICATION_PROPERTIES);

/** Project platform from the current anonymous game page so served HTML matches JSON-LD. */
export function gamePublicationReading(
  subject: Subject,
  definitions: PublicationDefinitions | undefined,
  locale: string,
  reader: Reader = defaultReader,
): GamePublicationReading | undefined {
  if (publicationOverlayKind(subject.type, definitions) !== 'game') return;
  const fields = subjectPublicationFields(subject, definitions, reader, locale).flatMap((field) => {
    if (!GAME_PROPERTY_SET.has(field.property)) return [];
    return [{ ...field, label: pageText(definitions?.properties[field.property]?.labels, locale) }];
  });
  return fields.length ? { type: 'schema:VideoGame', fields } : undefined;
}

export function gameOverlayReading(
  subject: Subject,
  definitions: PublicationDefinitions | undefined,
  locale: string,
  reader: Reader = defaultReader,
) {
  return publicationOverlayReading(subject, definitions, locale, 'game', reader);
}
