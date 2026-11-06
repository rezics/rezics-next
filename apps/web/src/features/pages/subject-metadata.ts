import type { Release } from '@rezics/definitions';
import { pageDocumentReferences, pickLanguage } from '@rezics/composition';
import { originalLanguage } from '../../subject/language';
import type { Related, Subject } from '../../subject/types';
import { defaultReader, type Reader } from '../../subject/reader';
import { bestRank, isRecord, pageText, spoilerLevel, webUrl, type Stmt } from './shared';

export type PublicationDefinitions = Pick<Release, 'types' | 'properties'>;
export type PublicationKind = 'book' | 'recipe' | 'game' | 'release' | 'agent';

/** Released Book facts the literary overlay must keep aligned with JSON-LD. */
export const BOOK_PUBLICATION_PROPERTIES = [
  'schema:author',
  'schema:wordCount',
  'wdt:P7937',
  'schema:keywords',
] as const;

/** Released Recipe facts the generic template does not place in Statements. */
export const RECIPE_PUBLICATION_PROPERTIES = [
  'schema:cookTime',
  'schema:suitableForDiet',
  'schema:recipeIngredient',
  'schema:recipeInstructions',
] as const;

/** Released game-work facts the client Game reader otherwise fetches after HTML. */
export const GAME_PUBLICATION_PROPERTIES = ['schema:gamePlatform'] as const;

/** Released software-release facts the generic template does not place in Statements. */
export const RELEASE_PUBLICATION_PROPERTIES = [
  'schema:gamePlatform',
  'schema:datePublished',
  'schema:inLanguage',
] as const;

/** Released agent identity links the generic SoftwareApplication template drops. */
export const AGENT_PUBLICATION_PROPERTIES = ['schema:sameAs', 'schema:url'] as const;

const BOOK_TYPES = ['schema:Book'] as const;
const RECIPE_TYPES = ['schema:Recipe'] as const;
const GAME_TYPES = ['schema:VideoGame'] as const;
const RELEASE_TYPES = ['wd:Q20631656'] as const;
const AGENT_TYPES = ['schema:Person', 'schema:Organization', 'schema:SoftwareApplication'] as const;

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

function matchesType(
  type: string,
  bases: readonly string[],
  definitions: PublicationDefinitions | undefined,
): boolean {
  return bases.some((base) => typeIsA(definitions, type, base) || type === base);
}

/** Released overlay kind, including descendants compiled into the page catalogue. */
export function publicationOverlayKind(
  type: string,
  definitions?: PublicationDefinitions,
): PublicationKind | undefined {
  if (matchesType(type, RECIPE_TYPES, definitions)) return 'recipe';
  if (matchesType(type, RELEASE_TYPES, definitions)) return 'release';
  if (matchesType(type, BOOK_TYPES, definitions)) return 'book';
  if (matchesType(type, GAME_TYPES, definitions)) return 'game';
  if (matchesType(type, AGENT_TYPES, definitions)) return 'agent';
}

const propertiesByKind: Record<PublicationKind, readonly string[]> = {
  book: BOOK_PUBLICATION_PROPERTIES,
  recipe: RECIPE_PUBLICATION_PROPERTIES,
  game: GAME_PUBLICATION_PROPERTIES,
  release: RELEASE_PUBLICATION_PROPERTIES,
  agent: AGENT_PUBLICATION_PROPERTIES,
};

/** Exact released identities, including descendants already compiled into the page catalogue. */
export function publicationPropertiesFor(type: string, definitions?: PublicationDefinitions): readonly string[] {
  const kind = publicationOverlayKind(type, definitions);
  return kind ? propertiesByKind[kind] : [];
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

export type PublicationOverlayReading = {
  kind: PublicationKind;
  fields: Array<PublicationField & { label: ReturnType<typeof pageText> }>;
};

/** Project only the overlay facts the named kind admits on the current anonymous page. */
export function publicationOverlayReading(
  subject: Subject,
  definitions: PublicationDefinitions | undefined,
  locale: string,
  kind: PublicationKind,
  reader: Reader = defaultReader,
): PublicationOverlayReading | undefined {
  if (publicationOverlayKind(subject.type, definitions) !== kind) return;
  const allowed = new Set<string>(propertiesByKind[kind]);
  const fields = subjectPublicationFields(subject, definitions, reader, locale).flatMap((field) => {
    if (!allowed.has(field.property)) return [];
    return [{ ...field, label: pageText(definitions?.properties[field.property]?.labels, locale) }];
  });
  return fields.length ? { kind, fields } : undefined;
}

/** A related Concept may already disclose its public identity URL on the same page read. */
export function relatedSameAs(related: Related[string] | undefined): string | undefined {
  if (!related || !('sameAs' in related) || typeof related.sameAs !== 'string') return;
  return webUrl(related.sameAs) ? related.sameAs : undefined;
}
