import type { Release } from '@rezics/definitions';
import { pageDocumentReferences, pickLanguage } from '@rezics/composition';
import { originalLanguage } from '../../subject/language';
import type { Related, Subject } from '../../subject/types';
import { defaultReader, type Reader } from '../../subject/reader';
import { bestRank, isRecord, spoilerLevel, webUrl, type Stmt } from './shared';

export type PublicationDefinitions = Pick<Release, 'types' | 'properties'>;

/** Released Recipe facts the generic template does not place in Statements. */
export const RECIPE_PUBLICATION_PROPERTIES = [
  'schema:cookTime',
  'schema:suitableForDiet',
  'schema:recipeIngredient',
  'schema:recipeInstructions',
] as const;

/** Released software-release facts the generic template does not place in Statements. */
export const RELEASE_PUBLICATION_PROPERTIES = [
  'schema:gamePlatform',
  'schema:datePublished',
  'schema:inLanguage',
] as const;

const RECIPE_TYPES = ['schema:Recipe'] as const;
const RELEASE_TYPES = ['wd:Q20631656'] as const;

function typeIsA(
  definitions: PublicationDefinitions | undefined,
  type: string,
  base: string,
  seen = new Set<string>(),
): boolean {
  if (type === base) return true;
  if (!definitions?.types[type] || seen.has(type)) return false;
  seen.add(type);
  return (definitions.types[type]?.bases ?? []).some((candidate) => typeIsA(definitions, candidate, base, seen));
}

/** Exact released identities, including descendants already compiled into the page catalogue. */
export function publicationPropertiesFor(type: string, definitions?: PublicationDefinitions): readonly string[] {
  if (RECIPE_TYPES.some((base) => typeIsA(definitions, type, base) || type === base))
    return RECIPE_PUBLICATION_PROPERTIES;
  if (RELEASE_TYPES.some((base) => typeIsA(definitions, type, base) || type === base))
    return RELEASE_PUBLICATION_PROPERTIES;
  return [];
}

function isStmt(value: unknown): value is Stmt {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.rank === 'string' &&
    isRecord(value.property) &&
    typeof value.property.id === 'string' &&
    typeof value.property.data_type === 'string' &&
    isRecord(value.value) &&
    typeof value.value.type === 'string' &&
    Array.isArray(value.qualifiers) &&
    Array.isArray(value.references)
  );
}

/** Rank and spoiler selection used by both the rendered overlay and JSON-LD. */
export function publicPublicationStatements(
  subject: Subject,
  property: string,
  reader: Reader = defaultReader,
  locale?: string,
): Stmt[] {
  const statements = (subject.statements[property] ?? []).filter(isStmt);
  const eligible = statements.filter(
    (statement) => (statement.rank === 'normal' || statement.rank === 'preferred') && spoilerLevel(statement) === 0,
  );
  if (!eligible.length) return [];
  const visible = bestRank(eligible).filter((statement) => spoilerLevel(statement) <= reader.spoilerLevel);
  if (!visible.some((statement) => statement.property.data_type === 'document')) return visible;
  const candidate = pageDocumentReferences(subject, [property], locale ?? 'en')[0]?.candidate;
  const selected = candidate ? visible.filter((statement) => statement.id === candidate) : [];
  const original = originalLanguage(subject);
  const languages = selected.flatMap((statement) => {
    const content = statement.value.type === 'value' ? statement.value.content : undefined;
    return statement.property.data_type === 'document' && isRecord(content) && typeof content.language === 'string'
      ? [content.language]
      : [];
  });
  const language = languages.length > 1 ? pickLanguage(languages, locale ?? 'en', original) : undefined;
  return selected.filter((statement) => {
    const content = statement.value.content;
    return language === undefined || !isRecord(content) || content.language === language;
  });
}

export type PublicationField = {
  property: string;
  statements: Stmt[];
};

/** Admitted public facts for one overlay, in released property order. Empty when the type has no overlay. */
export function subjectPublicationFields(
  subject: Subject,
  definitions: PublicationDefinitions | undefined,
  reader: Reader = defaultReader,
  locale?: string,
): PublicationField[] {
  return publicationPropertiesFor(subject.type, definitions).flatMap((property) => {
    if (definitions?.types[subject.type] && !definitions.types[subject.type]?.properties.includes(property)) return [];
    const statements = publicPublicationStatements(subject, property, reader, locale);
    return statements.length ? [{ property, statements }] : [];
  });
}

/** A related Concept may already disclose its public identity URL on the same page read. */
export function relatedSameAs(related: Related[string] | undefined): string | undefined {
  if (!related || !('sameAs' in related) || typeof related.sameAs !== 'string') return;
  return webUrl(related.sameAs) ? related.sameAs : undefined;
}
