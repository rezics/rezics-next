import { browserMainApi } from '../api/browser.ts';
import type { DetailsEntry, DetailsState, DetailsValues } from './details-form.tsx';
import type { MainClient, WorkMetadata } from './types.ts';

const tag = /^[a-z]{2,3}(-[A-Za-z0-9]{1,8})*$/i;
const completion = new Set(['ongoing', 'completed', 'hiatus', 'upcoming', 'cancelled']);

/** Rows a save sends: those with any value, trimmed. */
function detailsToSave(values: DetailsValues): DetailsValues {
  return { ...values, originalTitle: values.originalTitle.trim(), originalLanguage: values.originalLanguage.trim(),
    entries: values.entries.map(entry => ({ language: entry.language.trim(), title: entry.title.trim(),
      description: entry.description.trim(), tagline: entry.tagline.trim(), label: entry.label }))
      .filter(entry => entry.title || entry.description || entry.tagline || entry.label) };
}

/** What Main would refuse as details: a row without a language, a language twice, an original title without one. */
export function detailsInvalid(values: DetailsValues): boolean {
  return values.entries.some(entry => !tag.test(entry.language))
    || new Set(values.entries.map(entry => entry.language.toLowerCase())).size !== values.entries.length
    || (Boolean(values.originalTitle) && !tag.test(values.originalLanguage))
    || (values.completion !== '' && !completion.has(values.completion));
}

/** Details as the form edits them, from Main's header state: one row per language, the Work's own language first. */
export function detailsValues(metadata: WorkMetadata | null, language: string): DetailsValues {
  const entries: DetailsEntry[] = metadata?.localized.map(entry => ({ language: entry.language, title: entry.title ?? '',
    description: entry.description ?? '', tagline: entry.tagline ?? '', label: entry.mainVersionLabel ?? null })) ?? [];
  const own = entries.findIndex(entry => entry.language.toLowerCase() === language.toLowerCase());
  if (own > 0) entries.unshift(...entries.splice(own, 1));
  return { originalTitle: metadata?.originalTitle?.value ?? '', originalLanguage: metadata?.originalTitle?.language ?? '',
    completion: metadata?.completionStatus ?? '',
    entries: entries.length ? entries : [{ language, title: '', description: '', tagline: '', label: null }] };
}

/**
 * Saves a Work's header details on the head they were loaded from, as the
 * Studio Agent, from the browser: no page render follows, so a refusal or a
 * stale head never costs the writer's typing. A header save replaces the whole
 * header, so every field Studio does not edit (a language's Main Version
 * label) goes back as it was read. On a stale head the basis moves to the
 * head that won and its values come back to show beside the writer's, so
 * saving again is a deliberate overwrite.
 */
export async function saveWorkDetails(input: { actingSubject: string; work: string; head: string | null;
  values: DetailsValues }, main: MainClient = browserMainApi()): Promise<Omit<DetailsState, 'message'>> {
  const values = detailsToSave(input.values);
  const base = { head: input.head, values: input.values };
  if (detailsInvalid(values)) return { ...base, status: 'error', reason: 'invalid' };
  const api = main.v1.works({ id: input.work.slice(-36) }).metadata;
  try {
    const response = await api.put({ profile: 'work-metadata-details-v1', expectedHead: input.head,
      actingSubject: input.actingSubject, state: { kind: 'header',
        originalTitle: values.originalTitle ? { value: values.originalTitle, language: values.originalLanguage } : null,
        completionStatus: values.completion === '' ? null : values.completion,
        localized: values.entries.map(entry => ({ language: entry.language, title: entry.title || null,
          description: entry.description || null, tagline: entry.tagline || null, mainVersionLabel: entry.label })) } },
    { headers: { 'idempotency-key': crypto.randomUUID() } });
    if (response.data && 'revision' in response.data) return { status: 'saved', head: response.data.revision, values: input.values };
    const status = response.error?.status ?? 503;
    if (status === 401 || status === 403) return { ...base, status: 'denied' };
    if (status === 400 || status === 422) return { ...base, status: 'error', reason: 'invalid' };
    if (status === 409) {
      const current = await api.get({ query: { actingSubject: input.actingSubject } });
      if (current.data) {
        const theirs = detailsValues(current.data, values.entries[0]?.language ?? '').entries;
        return { status: 'stale', head: current.data.revision, values: input.values, theirs };
      }
    }
    return { ...base, status: 'error', reason: response.data ? 'pending' : 'failed' };
  } catch {
    return { ...base, status: 'error', reason: 'failed' };
  }
}
