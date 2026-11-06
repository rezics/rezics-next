import type { Related, Subject } from '../../../subject/types';
import { defaultReader, type Reader } from '../../../subject/reader';
import type { PageLink } from '../shared';
import { PublicationOverlayView } from '../publication-overlay';
import type { PublicationDefinitions } from '../subject-metadata';
import { recipePublicationReading } from './model';

/** No extra read: overlay uses the current anonymous page's statements, related and documents. */
export function RecipePublicationEntry({
  subject,
  related,
  documents,
  definitions,
  locale,
  reader = defaultReader,
  link,
}: {
  subject: Subject;
  related: Related;
  documents?: unknown;
  definitions?: PublicationDefinitions | undefined;
  locale: string;
  reader?: Reader;
  link?: PageLink | undefined;
}) {
  const reading = recipePublicationReading(subject, definitions, locale, reader);
  if (!reading) return null;
  return (
    <PublicationOverlayView
      reading={{ kind: 'recipe', fields: reading.fields }}
      subject={subject}
      related={related}
      locale={locale}
      {...(documents !== undefined ? { documents } : {})}
      {...(link ? { link } : {})}
    />
  );
}
