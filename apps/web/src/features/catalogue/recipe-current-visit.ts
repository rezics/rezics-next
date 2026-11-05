import { candidateContext } from '../../subject/candidates';
import { subjectHref } from '../../subject/subject-href';
import { contextHref } from '../pages/context-navigation';

/** Navigation intent only. Native reads and command admission remain authoritative. */
export type RecipeOccurrence = { property: string; statement: string; holder: string };
export type RecipeVisit = { context: string; realm?: string; occurrence?: RecipeOccurrence };
export type RecipeVisitInput = { valid: true; visit: RecipeVisit } | { valid: false };
export const recipeVisitByteLimit = 8192;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const fields = new Set([
  'schema:recipeIngredient',
  'wdt:P186',
  'schema:cookTime',
  'schema:recipeYield',
  'schema:suitableForDiet',
  'schema:recipeInstructions',
]);

/** HTTP address boundary: reject ambiguous selectors rather than silently opening Global. */
export function parseRecipeVisit(search: string): RecipeVisitInput {
  if (new TextEncoder().encode(search).byteLength > recipeVisitByteLimit) return { valid: false };
  const params = new URLSearchParams(search);
  const keys = ['context', 'realm', 'property', 'statement', 'holder'];
  for (const key of params.keys()) if (!keys.includes(key) || params.getAll(key).length !== 1) return { valid: false };
  const context = params.get('context') ?? candidateContext;
  if (!uuid.test(context)) return { valid: false };
  const realm = params.get('realm');
  // A population selector without its observed Context cannot identify a correction reading.
  if (realm !== null && (!params.has('context') || !uuid.test(realm))) return { valid: false };
  const property = params.get('property');
  const statement = params.get('statement');
  const holder = params.get('holder');
  if (
    [property, statement, holder].some((part) => part !== null) &&
    (!property || !fields.has(property) || !statement || !uuid.test(statement) || !holder || !uuid.test(holder))
  )
    return { valid: false };
  return {
    valid: true,
    visit: {
      context,
      ...(realm ? { realm } : {}),
      ...(property && statement && holder ? { occurrence: { property, statement, holder } } : {}),
    },
  };
}

export function recipeVisitSearch(visit: RecipeVisit): string {
  const params = new URLSearchParams({ context: visit.context });
  if (visit.realm) params.set('realm', visit.realm);
  if (visit.occurrence) for (const [key, value] of Object.entries(visit.occurrence)) params.set(key, value);
  return `?${params}`;
}

export function recipeCorrectionHref(
  subject: { id: string; label: string },
  locale: string,
  visit: RecipeVisit,
): string {
  return `${subjectHref(subject, locale).href}/recipe${recipeVisitSearch(visit)}`;
}

/** One public source address, with only the existing Realm selector. No copied read or receipt. */
export function recipeSourceHref(
  subject: { id: string; label: string },
  locale: string,
  visit: RecipeVisit,
): string | undefined {
  if (visit.context !== candidateContext && !visit.realm) return undefined;
  return contextHref(subjectHref(subject, locale).href, visit.realm);
}
