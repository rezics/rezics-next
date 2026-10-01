import { parseLanguage } from '@rezics/main/language';
import { browserMainApi } from '../api/browser.ts';
import { detailsValues, saveWorkDetails } from '../studio/details-api.ts';

export type AliasResult = 'saved' | 'denied' | 'taken' | 'invalid' | 'failed';
export type AliasSaver = (input: { actingSubject: string; work: string; alias: string; language: string }) => Promise<AliasResult>;

/**
 * Adds a name to an existing record: a title in one more language, saved on the head just read.
 * Main decides whether this contributor may change the record; a language that already has a
 * different title is left alone, since a header holds one title per language.
 */
export const saveAlias: AliasSaver = async ({ actingSubject, work, alias, language }) => {
  const text = alias.trim();
  if (!text || text.length > 500 || !parseLanguage(language)) return 'invalid';
  const api = browserMainApi().v1.works({ id: work.slice(-36) }).metadata;
  try {
    const current = await api.get({ query: { actingSubject } });
    if (current.error && current.error.status !== 404) {
      return current.error.status === 401 || current.error.status === 403 ? 'denied' : 'failed';
    }
    const metadata = current.data ?? null;
    const values = detailsValues(metadata, language);
    const own = values.entries.find(entry => entry.language.toLowerCase() === language.toLowerCase());
    if (own?.title && own.title !== text) return 'taken';
    const entries = own ? values.entries.map(entry => entry === own ? { ...entry, title: text } : entry)
      : [...values.entries, { language, title: text, description: '', tagline: '', label: null }];
    const saved = await saveWorkDetails({ actingSubject, work, head: metadata?.revision ?? null,
      values: { ...values, entries } });
    if (saved.status === 'saved') return 'saved';
    return saved.status === 'denied' ? 'denied' : saved.status === 'error' && saved.reason === 'invalid' ? 'invalid' : 'failed';
  } catch { return 'failed'; }
};
