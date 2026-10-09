import type { ZoneText } from '@rezics/zone-sdk';

// A catalogue count is a public property. The lexicon key returns its kind and the
// subject → value rendering; a relation, or a property that is not named that way, is
// not a count. The number itself stays a Statement. The rendering only names the property.

export interface CatalogueCountProperty {
  /** Statement predicate of the declared count. */
  predicate: string;
  /**
   * Reviewed name in the page language. Null when that language has no reviewed
   * presentation: the package then uses its own word, and the count is not hidden.
   */
  name: ZoneText | null;
}

interface CountProjection {
  fromRole?: unknown;
  toRole?: unknown;
  reviewStatus?: unknown;
  language?: unknown;
  direction?: unknown;
  fallback?: unknown;
  labels?: { noun?: unknown } | null;
}

/** The definition-key body, as far as a count needs it. Extra fields are ignored. */
export interface CatalogueDefinitionRead {
  kind?: unknown;
  definition?: unknown;
  rendering?: {
    viewingRole?: unknown;
    meaning?: { definition?: unknown };
    projections?: readonly CountProjection[];
  } | null;
}

function reviewedName(projections: readonly CountProjection[], locale: string): ZoneText | null {
  const named = projections.find(item => item.fromRole === 'subject' && item.toRole === 'value'
    && item.reviewStatus === 'reviewed' && item.fallback === null && item.language === locale
    && (item.direction === 'ltr' || item.direction === 'rtl')
    && item.labels && typeof item.labels.noun === 'string' && item.labels.noun.length > 0);
  if (!named || typeof named.language !== 'string') return null;
  const direction = named.direction === 'rtl' ? 'rtl' : 'ltr';
  return { value: (named.labels as { noun: string }).noun, lang: named.language, dir: direction };
}

/**
 * The count predicate of a public property definition, or null when the key is not one.
 * A missing reviewed name does not drop the predicate: the Statement still records the number.
 */
export function catalogueCountProperty(definition: unknown, locale: string): CatalogueCountProperty | null {
  if (!definition || typeof definition !== 'object') return null;
  const body = definition as CatalogueDefinitionRead;
  if (body.kind !== 'property' || typeof body.definition !== 'string') return null;
  const rendering = body.rendering;
  if (!rendering || rendering.viewingRole !== 'subject') return null;
  if (rendering.meaning?.definition !== body.definition) return null;
  const projections = rendering.projections ?? [];
  if (!projections.some(item => item.fromRole === 'subject' && item.toRole === 'value')) return null;
  return { predicate: body.definition, name: reviewedName(projections, locale) };
}
