import type { Related, Subject } from '../../../subject/types';
import { defaultReader, type Reader } from '../../../subject/reader';
import type { PageLink } from '../shared';
import type { PublicationDefinitions } from '../subject-metadata';
import { recipePublicationReading } from './model';
import { RecipePublicationView } from './view';

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
  definitions?: PublicationDefinitions;
  locale: string;
  reader?: Reader;
  link?: PageLink;
}) {
  const reading = recipePublicationReading(subject, definitions, locale, reader);
  if (!reading) return null;
  return (
    <RecipePublicationView
      reading={reading}
      subject={subject}
      related={related}
      documents={documents}
      locale={locale}
      reader={reader}
      {...(link ? { link } : {})}
    />
  );
}
