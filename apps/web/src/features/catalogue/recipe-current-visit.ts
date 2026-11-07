import { candidateContext } from '../pages/visit-host-port';
import { subjectHref } from '../../subject/subject-href';
import { contextHref } from '../pages/context-navigation';
import { subjectVisitReturn } from '../pages/subject-visit-navigation';

/** Navigation intent only. Native reads and command admission remain authoritative. */
export type RecipeOccurrence = { property: string; statement: string; holder: string };
export type RecipeVisit = {
  context: string;
  realm?: string;
  occurrence?: RecipeOccurrence;
  /** Canonical public Subject address, optionally retaining one validated prior visit. */
  returnHref?: string;
  /** The entry had no bounded public return address; only a separately named general reading may be offered. */
  returnUnsupported?: true;
};
export type RecipeVisitInput = { valid: true; visit: RecipeVisit } | { valid: false };
export type RecipeReturnFocus = 'keyboard' | 'pointer';
export type RecipeCurrentReturn = {
  recipe: string;
  context: string;
  realm?: string;
  occurrence?: RecipeOccurrence;
  focus: RecipeReturnFocus;
  visit: string;
};
export type RecipeCurrentReturnInput =
  | { kind: 'absent' }
  | { kind: 'invalid' }
  | { kind: 'valid'; value: RecipeCurrentReturn };
export type RecipeCurrentReturnState = 'ready' | 'changed' | 'removed' | 'unsupported';

export const recipeVisitByteLimit = 8192;
const publicReturnAddressByteLimit = 5600;
const uuidSegment = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const uuid = new RegExp(`^${uuidSegment}$`);
const fields = new Set([
  'schema:recipeIngredient',
  'wdt:P186',
  'schema:cookTime',
  'schema:recipeYield',
  'schema:suitableForDiet',
  'schema:recipeInstructions',
]);
const localePattern = '(?:en|zh-Hant|zh-Hans|ja|ko|fr|de|es)';
const subjectPath = new RegExp(`^/(${localePattern})/subjects/(${uuidSegment})/[^/?#]+$`, 'i');
const currentReturnKey = 'recipeReturn';

function encodeAddress(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function decodeAddress(value: string): string | undefined {
  if (!/^[A-Za-z0-9_-]{1,8192}$/u.test(value)) return;
  try {
    const standard = value.replaceAll('-', '+').replaceAll('_', '/');
    const binary = atob(standard + '='.repeat((4 - (standard.length % 4)) % 4));
    return new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    );
  } catch {
    return;
  }
}

/** Validate one public same-locale recipe overview and its optional single prior visit. */
export function recipePublicReturnAddress(value: string, locale: string, recipe: string): string | undefined {
  if (new TextEncoder().encode(value).byteLength > publicReturnAddressByteLimit || !value.startsWith('/')) return;
  try {
    const url = new URL(value, 'https://rezics.invalid');
    const match = subjectPath.exec(url.pathname);
    const keys = [...url.searchParams.keys()];
    const realms = url.searchParams.getAll('realm');
    const previous = url.searchParams.getAll('via');
    if (
      url.origin !== 'https://rezics.invalid' ||
      url.hash ||
      !match ||
      match[1] !== locale ||
      match[2]?.toLowerCase() !== recipe.toLowerCase() ||
      keys.some((key) => key !== 'realm' && key !== 'via') ||
      new Set(keys).size !== keys.length ||
      realms.length > 1 ||
      (realms.length === 1 && !uuid.test(realms[0]!)) ||
      previous.length > 1
    )
      return;
    const acceptedPrevious = previous.length ? subjectVisitReturn(previous[0], locale) : undefined;
    if (previous.length && !acceptedPrevious) return;
    if (acceptedPrevious) url.searchParams.set('via', acceptedPrevious);
    const address = `${url.pathname}${url.search}`;
    return new TextEncoder().encode(address).byteLength <= publicReturnAddressByteLimit ? address : undefined;
  } catch {
    return;
  }
}

/** A canonical Subject address, with only its existing public Realm and one validated `via`. */
export function recipePublicSubjectHref(
  subject: { id: string; label: string },
  locale: string,
  visit: Pick<RecipeVisit, 'context' | 'realm'>,
  previous?: string,
): string | undefined {
  if (visit.context !== candidateContext && !visit.realm) return;
  const href = contextHref(subjectHref(subject, locale).href, visit.realm);
  const url = new URL(href, 'https://rezics.invalid');
  if (previous) {
    const acceptedPrevious = subjectVisitReturn(previous, locale);
    if (!acceptedPrevious) return;
    url.searchParams.set('via', acceptedPrevious);
  }
  return recipePublicReturnAddress(`${url.pathname}${url.search}`, locale, subject.id);
}

/** HTTP address boundary: reject ambiguous selectors rather than silently opening Global. */
export function parseRecipeVisit(search: string, locale?: string, recipe?: string): RecipeVisitInput {
  if (new TextEncoder().encode(search).byteLength > recipeVisitByteLimit) return { valid: false };
  const params = new URLSearchParams(search);
  const keys = ['context', 'realm', 'property', 'statement', 'holder', 'return'];
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
  const encodedReturn = params.get('return');
  const returnAddress = encodedReturn && encodedReturn !== 'unsupported' ? decodeAddress(encodedReturn) : undefined;
  const returnHref =
    returnAddress && locale && recipe ? recipePublicReturnAddress(returnAddress, locale, recipe) : undefined;
  const returnUnsupported = encodedReturn === 'unsupported';
  if (encodedReturn !== null && !returnHref && !returnUnsupported) return { valid: false };
  return {
    valid: true,
    visit: {
      context,
      ...(realm ? { realm } : {}),
      ...(property && statement && holder ? { occurrence: { property, statement, holder } } : {}),
      ...(returnHref ? { returnHref } : {}),
      ...(returnUnsupported ? { returnUnsupported: true as const } : {}),
    },
  };
}

export function recipeVisitSearch(visit: RecipeVisit): string {
  const params = new URLSearchParams({ context: visit.context });
  if (visit.realm) params.set('realm', visit.realm);
  if (visit.occurrence) for (const [key, value] of Object.entries(visit.occurrence)) params.set(key, value);
  if (visit.returnHref) params.set('return', encodeAddress(visit.returnHref));
  else if (visit.returnUnsupported) params.set('return', 'unsupported');
  return `?${params}`;
}

export function recipeCorrectionHref(
  subject: { id: string; label: string },
  locale: string,
  visit: RecipeVisit,
): string {
  return `${subjectHref(subject, locale).href}/recipe${recipeVisitSearch(visit)}`;
}

/** Add one data-free, bounded focus intent to the validated public destination. */
export function recipeCurrentReturnHref(
  address: string | undefined,
  value: RecipeCurrentReturn,
  locale: string,
): string | undefined {
  if (!address || !uuid.test(value.recipe) || !uuid.test(value.context) || !uuid.test(value.visit)) return;
  const accepted = recipePublicReturnAddress(address, locale, value.recipe);
  if (!accepted) return;
  if (value.realm && !uuid.test(value.realm)) return;
  if (
    value.occurrence &&
    (value.occurrence.holder.toLowerCase() !== value.recipe.toLowerCase() ||
      !fields.has(value.occurrence.property) ||
      !uuid.test(value.occurrence.statement))
  )
    return;
  const url = new URL(accepted, 'https://rezics.invalid');
  const addressRealm = url.searchParams.get('realm') ?? undefined;
  if (addressRealm !== value.realm) return;
  const occurrence = value.occurrence;
  const encoded = JSON.stringify([
    1,
    value.recipe,
    value.context,
    value.realm ?? null,
    occurrence?.property ?? null,
    occurrence?.statement ?? null,
    occurrence?.holder ?? null,
    value.focus,
    value.visit,
  ]);
  url.searchParams.set(currentReturnKey, encoded);
  const href = `${url.pathname}${url.search}`;
  return new TextEncoder().encode(href).byteLength <= recipeVisitByteLimit ? href : undefined;
}

/** Parse a return marker only on its same-locale recipe Subject overview address. */
export function parseRecipeCurrentReturn(href: string, locale: string): RecipeCurrentReturnInput {
  if (new TextEncoder().encode(href).byteLength > recipeVisitByteLimit)
    return href.includes(currentReturnKey) ? { kind: 'invalid' } : { kind: 'absent' };
  try {
    const url = new URL(href, 'https://rezics.invalid');
    if (!url.searchParams.has(currentReturnKey)) return { kind: 'absent' };
    if (!href.startsWith('/')) return { kind: 'invalid' };
    const match = subjectPath.exec(url.pathname);
    const keys = [...url.searchParams.keys()];
    const recipeReturns = url.searchParams.getAll(currentReturnKey);
    const realms = url.searchParams.getAll('realm');
    const previous = url.searchParams.getAll('via');
    if (
      url.origin !== 'https://rezics.invalid' ||
      url.hash ||
      !match ||
      match[1] !== locale ||
      keys.some((key) => key !== 'realm' && key !== 'via' && key !== currentReturnKey) ||
      new Set(keys).size !== keys.length ||
      recipeReturns.length !== 1 ||
      realms.length > 1 ||
      (realms.length === 1 && !uuid.test(realms[0]!)) ||
      previous.length > 1 ||
      (previous.length === 1 && !subjectVisitReturn(previous[0], locale))
    )
      return { kind: 'invalid' };
    const decoded: unknown = JSON.parse(recipeReturns[0]!);
    if (!Array.isArray(decoded) || decoded.length !== 9 || decoded[0] !== 1) return { kind: 'invalid' };
    const [, recipe, context, realm, property, statement, holder, focus, visit] = decoded;
    const noOccurrence = property === null && statement === null && holder === null;
    const occurrence =
      typeof property === 'string' && typeof statement === 'string' && typeof holder === 'string'
        ? { property, statement, holder }
        : undefined;
    if (
      typeof recipe !== 'string' ||
      !uuid.test(recipe) ||
      recipe.toLowerCase() !== match[2]?.toLowerCase() ||
      typeof context !== 'string' ||
      !uuid.test(context) ||
      (realm !== null && (typeof realm !== 'string' || !uuid.test(realm))) ||
      (realm ?? undefined) !== (realms[0] ?? undefined) ||
      (!noOccurrence &&
        (!occurrence ||
          occurrence.holder.toLowerCase() !== recipe.toLowerCase() ||
          !fields.has(occurrence.property) ||
          !uuid.test(occurrence.statement))) ||
      (focus !== 'keyboard' && focus !== 'pointer') ||
      typeof visit !== 'string' ||
      !uuid.test(visit)
    )
      return { kind: 'invalid' };
    return {
      kind: 'valid',
      value: {
        recipe,
        context,
        ...(typeof realm === 'string' ? { realm } : {}),
        ...(occurrence ? { occurrence } : {}),
        focus,
        visit,
      },
    };
  } catch {
    return { kind: 'invalid' };
  }
}

export function recipeCurrentReturnState(
  intent: RecipeCurrentReturn,
  observation:
    | {
        subject: { id: string; type: string };
        context: string;
        realm?: string;
        occurrences: readonly RecipeOccurrence[];
      }
    | undefined,
): RecipeCurrentReturnState {
  if (!observation || observation.subject.type !== 'schema:Recipe') return 'unsupported';
  if (
    observation.subject.id.toLowerCase() !== intent.recipe.toLowerCase() ||
    observation.context.toLowerCase() !== intent.context.toLowerCase() ||
    observation.realm !== intent.realm
  )
    return 'changed';
  if (
    intent.occurrence &&
    !observation.occurrences.some(
      (occurrence) =>
        occurrence.property === intent.occurrence!.property &&
        occurrence.statement.toLowerCase() === intent.occurrence!.statement.toLowerCase() &&
        occurrence.holder.toLowerCase() === intent.occurrence!.holder.toLowerCase(),
    )
  )
    return 'removed';
  return 'ready';
}

/** One public source address with its existing Realm and one prior visit; no copied read or receipt. */
export function recipeSourceHref(
  subject: { id: string; label: string },
  locale: string,
  visit: RecipeVisit,
): string | undefined {
  return visit.returnHref ?? recipePublicSubjectHref(subject, locale, visit);
}
