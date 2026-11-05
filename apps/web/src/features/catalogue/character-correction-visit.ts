import { subjectHref } from '../../subject/subject-href';
import { candidateContext } from '../../subject/candidates';
import { characterUuid } from './character-profile';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CharacterCorrectionSearch = {
  work?: string;
  context?: string;
  realm?: string;
  classificationHandoff?: string;
};

export type CharacterCorrectionSearchResult = { ok: true; value: CharacterCorrectionSearch } | { ok: false };

/** Parse only the independent address fields; classification custody stays with its existing parser. */
export function parseCharacterCorrectionSearch(input: unknown): CharacterCorrectionSearchResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false };
  const search = input as Record<string, unknown>;
  if (
    (search.work !== undefined && (typeof search.work !== 'string' || !characterUuid.test(search.work))) ||
    (search.context !== undefined && (typeof search.context !== 'string' || !uuid.test(search.context))) ||
    (search.realm !== undefined && (typeof search.realm !== 'string' || !uuid.test(search.realm)))
  )
    return { ok: false };
  return {
    ok: true,
    value: {
      ...(search.work ? { work: search.work } : {}),
      ...(search.context ? { context: search.context } : {}),
      ...(search.realm ? { realm: search.realm } : {}),
    },
  };
}

/** Server route inputs retain duplicate query keys; reject ambiguity before canonical redirecting them. */
export function parseCharacterCorrectionUrl(search: string): CharacterCorrectionSearchResult {
  if (!characterSearchWithinLimit(search)) return { ok: false };
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const values: Record<string, string> = {};
  for (const key of ['work', 'context', 'realm'] as const) {
    const entries = params.getAll(key);
    if (entries.length > 1) return { ok: false };
    if (entries[0] !== undefined) values[key] = entries[0];
  }
  return parseCharacterCorrectionSearch(values);
}

/** Keep the selected Work and existing classification custody on a fresh, deliberate Global visit. */
export function globalCharacterCorrectionHref(
  address: CharacterCorrectionSearch & { id: string; label: string; locale: string },
): string {
  const params = new URLSearchParams({ context: candidateContext });
  if (address.work) params.set('work', address.work);
  if (address.classificationHandoff) params.set('classificationHandoff', address.classificationHandoff);
  const href = `${subjectHref({ id: address.id, label: address.label }, address.locale).href}/character?${params}`;
  const bytes = new TextEncoder().encode(href).length;
  if (href.length > 2048 || bytes > 2048) throw new Error('Character Global address exceeds its route limit');
  return href;
}

/** A context selection without its Realm has no compatible public return route. */
export function characterPublicReturnHref(
  address: CharacterCorrectionSearch & { id: string; label: string; locale: string },
): string | undefined {
  const context = address.context ?? candidateContext;
  if (context !== candidateContext && !address.realm) return;
  const base = subjectHref({ id: address.id, label: address.label }, address.locale).href;
  return address.realm ? `${base}?${new URLSearchParams({ realm: address.realm })}` : base;
}

/** A full route search is bounded before canonical redirects preserve it byte-for-byte. */
export function characterSearchWithinLimit(search: string): boolean {
  return search.length <= 2048 && new TextEncoder().encode(search).length <= 2048;
}
