import type { Reader } from '../../../subject/reader';
import { defaultReader } from '../../../subject/reader';
import { pageText, type Related, type Stmt, type Subject } from '../shared';
import {
  RECIPE_PUBLICATION_PROPERTIES,
  publicationOverlayKind,
  subjectPublicationFields,
  type PublicationDefinitions,
  type PublicationField,
} from '../subject-metadata';

export type RecipePublicationField = PublicationField & {
  label: ReturnType<typeof pageText>;
};

export type RecipePublicationReading = {
  type: 'schema:Recipe';
  fields: RecipePublicationField[];
};

const RECIPE_PROPERTY_SET = new Set<string>(RECIPE_PUBLICATION_PROPERTIES);

/** Project only the released Recipe facts the generic overview otherwise drops. */
export function recipePublicationReading(
  subject: Subject,
  definitions: PublicationDefinitions | undefined,
  locale: string,
  reader: Reader = defaultReader,
): RecipePublicationReading | undefined {
  if (publicationOverlayKind(subject.type, definitions) !== 'recipe') return;
  const fields = subjectPublicationFields(subject, definitions, reader, locale).flatMap((field) => {
    if (!RECIPE_PROPERTY_SET.has(field.property)) return [];
    const label = pageText(definitions?.properties[field.property]?.labels, locale);
    return [{ ...field, label }];
  });
  return fields.length ? { type: 'schema:Recipe', fields } : undefined;
}

export function recipeInstructionStatement(field: RecipePublicationField): Stmt | undefined {
  return field.property === 'schema:recipeInstructions' ? field.statements[0] : undefined;
}

export function recipeRelatedTarget(statement: Stmt, related: Related): Related[string] | undefined {
  if (statement.property.data_type !== 'wikibase-item' || statement.value.type !== 'value') return;
  const id = statement.value.content;
  return typeof id === 'string' && Object.hasOwn(related, id) ? related[id] : undefined;
}
