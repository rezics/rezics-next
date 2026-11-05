import { PAGE_GLOBAL_CONTEXT } from '@rezics/composition';
import { subjectVisitReturn } from '../pages/subject-visit-navigation';
import { subjectHref } from '../../subject/subject-href';
import { storyArcUuid } from './story-arc-profile';

export const storyArcOuterSearchLimit = 2048;

export type StoryArcProfileVisit = {
  work?: string;
  realm?: string;
  context?: string;
  definition?: string;
  via?: string;
  classificationHandoff?: string;
};

const profileSearchKeys = new Set(['work', 'realm', 'context', 'definition', 'via', 'classificationHandoff']);

/** Canonicalize only a label change on the same identity; a redirect identity stays stale. */
export function storyArcCanonicalSlugTarget(input: {
  id: string;
  slug: string;
  currentId: string;
  label: string;
  locale: string;
}): string | undefined {
  if (input.currentId !== input.id) return;
  const canonical = subjectHref({ id: input.id, label: input.label }, input.locale);
  return canonical.params.slug === input.slug ? undefined : canonical.href;
}

function boundedSearch(value: string): boolean {
  return (
    value.length <= storyArcOuterSearchLimit && new TextEncoder().encode(value).byteLength <= storyArcOuterSearchLimit
  );
}

function immediateOrigin(
  value: string,
  id: string,
  locale: string,
  realm?: string,
  requireRealmMatch = true,
): string | undefined {
  const accepted = subjectVisitReturn(value, locale);
  if (!accepted) return;
  const url = new URL(accepted, 'https://rezics.invalid');
  const subject = /^\/(en|zh-Hant|zh-Hans|ja|ko|fr|de|es)\/subjects\/([0-9a-f-]{36})\/[^/?#]+$/iu.exec(url.pathname);
  if (
    url.origin !== 'https://rezics.invalid' ||
    !subject ||
    subject[1] !== locale ||
    subject[2]?.toLowerCase() !== id.toLowerCase() ||
    url.hash !== '#connections'
  )
    return;
  const keys = [...url.searchParams.keys()];
  const originRealms = url.searchParams.getAll('realm');
  if (
    keys.some((key) => key !== 'realm') ||
    new Set(keys).size !== keys.length ||
    originRealms.length > 1 ||
    (requireRealmMatch && (originRealms[0] ?? undefined) !== realm) ||
    (originRealms[0] !== undefined && !storyArcUuid.test(originRealms[0]))
  )
    return;
  return accepted;
}

/** The Subject page supplies a current address; only its identity, locale and admitted Realm survive. */
export function storyArcPublicOrigin(input: {
  currentHref?: string;
  id: string;
  locale: string;
  realm?: string;
}): string | undefined {
  const { currentHref, id, locale, realm } = input;
  if (!currentHref || !storyArcUuid.test(id) || (realm !== undefined && !storyArcUuid.test(realm))) return;
  const accepted = subjectVisitReturn(currentHref, locale);
  if (!accepted) return;
  const source = new URL(accepted, 'https://rezics.invalid');
  const subject = /^\/(en|zh-Hant|zh-Hans|ja|ko|fr|de|es)\/subjects\/([0-9a-f-]{36})\/[^/?#]+$/iu.exec(source.pathname);
  const sourceRealms = source.searchParams.getAll('realm');
  if (
    source.origin !== 'https://rezics.invalid' ||
    !subject ||
    subject[1] !== locale ||
    subject[2]?.toLowerCase() !== id.toLowerCase() ||
    sourceRealms.length > 1 ||
    (sourceRealms[0] ?? undefined) !== realm ||
    (sourceRealms[0] !== undefined && !storyArcUuid.test(sourceRealms[0]))
  )
    return;
  // Existing Subject return validation supplies the public overview's admitted heading landmark.
  const query = realm ? `?realm=${encodeURIComponent(realm)}` : '';
  const origin = subjectVisitReturn(`${source.pathname}${query}#connections`, locale);
  return origin && immediateOrigin(origin, id, locale, realm) ? origin : undefined;
}

/** Validate the typed route projection after the router parses its search object. */
export function storyArcProfileSearch(
  input: Record<string, unknown>,
  locale: string,
  id?: string,
): StoryArcProfileVisit | undefined {
  if (Object.keys(input).some((key) => !profileSearchKeys.has(key))) return;
  const value = (key: keyof StoryArcProfileVisit): string | undefined => {
    const item = input[key];
    if (item === undefined) return;
    return typeof item === 'string' ? item : undefined;
  };
  for (const key of profileSearchKeys) {
    const item = input[key];
    if (item !== undefined && typeof item !== 'string') return;
  }
  const work = value('work');
  const realm = value('realm');
  const context = value('context');
  const definition = value('definition');
  const via = value('via');
  const classificationHandoff = value('classificationHandoff');
  const acceptedVia =
    via === undefined
      ? undefined
      : id
        ? immediateOrigin(via, id, locale, realm, realm !== undefined)
        : subjectVisitReturn(via, locale);
  const originRealm = acceptedVia ? new URL(acceptedVia, 'https://rezics.invalid').searchParams.get('realm') : null;
  if (
    (work !== undefined && !storyArcUuid.test(work)) ||
    (realm !== undefined && !storyArcUuid.test(realm)) ||
    (context !== undefined && !storyArcUuid.test(context)) ||
    (definition !== undefined && !/^[A-Za-z0-9:._-]{1,128}$/u.test(definition)) ||
    (via !== undefined && (via.length > storyArcOuterSearchLimit || !acceptedVia)) ||
    (context === PAGE_GLOBAL_CONTEXT && (realm !== undefined || originRealm !== null))
  )
    return;
  return {
    ...(work ? { work } : {}),
    ...(realm ? { realm } : {}),
    ...(context ? { context } : {}),
    ...(definition ? { definition } : {}),
    ...(acceptedVia ? { via: acceptedVia } : {}),
    ...(classificationHandoff ? { classificationHandoff } : {}),
  };
}

/** Reject duplicate, malformed, unknown and over-budget raw query input before route admission. */
export function parseStoryArcProfileSearch(
  rawSearch: string,
  id: string,
  locale: string,
): StoryArcProfileVisit | undefined {
  if (!storyArcUuid.test(id) || !boundedSearch(rawSearch)) return;
  const raw = rawSearch.startsWith('?') ? rawSearch.slice(1) : rawSearch;
  const pairs: [string, string][] = [];
  if (raw) {
    for (const part of raw.split('&')) {
      if (!part) return;
      const separator = part.indexOf('=');
      const key = separator < 0 ? part : part.slice(0, separator);
      const encodedValue = separator < 0 ? '' : part.slice(separator + 1);
      let decodedKey: string;
      let decodedValue: string;
      try {
        decodedKey = decodeURIComponent(key.replace(/\+/gu, ' '));
        decodedValue = decodeURIComponent(encodedValue.replace(/\+/gu, ' '));
      } catch {
        return;
      }
      if (!decodedKey || pairs.some(([seen]) => seen === decodedKey)) return;
      pairs.push([decodedKey, decodedValue]);
    }
  }
  const parsed = storyArcProfileSearch(Object.fromEntries(pairs), locale, id);
  if (!parsed) return;
  const via = parsed.via;
  if (via) {
    const origin = new URL(via, 'https://rezics.invalid');
    const originRealm = origin.searchParams.get('realm');
    if (parsed.realm !== undefined && originRealm?.toLowerCase() !== parsed.realm.toLowerCase()) return;
  }
  return parsed;
}

/** A deliberate Global choice preserves only the immediate public return and the current identity route. */
export function storyArcGlobalChoiceHref(input: { id: string; slug: string; locale: string; via?: string }): string {
  const { id, slug, locale, via } = input;
  const path = `/${encodeURIComponent(locale)}/subjects/${encodeURIComponent(id)}/${encodeURIComponent(slug)}/story-arc`;
  const candidate = via && subjectVisitReturn(via, locale);
  const originRealm = candidate ? new URL(candidate, 'https://rezics.invalid').searchParams.getAll('realm') : [];
  const acceptedVia =
    candidate && originRealm.length <= 1 && immediateOrigin(candidate, id, locale, originRealm[0] ?? undefined);
  const query = acceptedVia ? new URLSearchParams({ via: acceptedVia }).toString() : '';
  if (query && !boundedSearch(query)) throw new Error('StoryArc public return exceeds its outer address limit');
  return `${path}${query ? `?${query}` : ''}`;
}
