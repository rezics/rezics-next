// SPDX-License-Identifier: Apache-2.0
import { pickLanguage } from './strings.ts';

export type PageDocumentRead = { kind: 'documents'; id: string; context?: string; properties: string[] };
export type PageDocumentReference = { candidate: string; document: string; digest: string; language: string };
/** One subject observation leaves at most fifteen native document operations. */
export const MAX_PAGE_DOCUMENTS = 15;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function publicQualifierSet(value: Record<string, unknown>): boolean {
  if (!Object.hasOwn(value, 'qualifiers')) return true;
  if (!Array.isArray(value.qualifiers)) return false;
  return value.qualifiers.every((entry) => {
    if (!record(entry) || !record(entry.property) || typeof entry.property.id !== 'string') return false;
    if (entry.property.id !== 'rezics:spoilerLevel') return true;
    const content = record(entry.value) && entry.value.type === 'value' ? entry.value.content : undefined;
    const amount = record(content) ? Number(content.amount) : Number.NaN;
    return Number.isInteger(amount) && amount === 0;
  });
}

export function pageDocumentReferences(
  subject: unknown,
  properties: readonly string[],
  locale: string,
): PageDocumentReference[] {
  if (!record(subject) || !record(subject.statements)) return [];
  const statements = subject.statements;
  const ranked = (property: string) => {
    const all = statements[property];
    if (!Array.isArray(all)) return [];
    const rows = all.filter((row): row is Record<string, unknown> => record(row) && publicQualifierSet(row));
    const rank = rows.some((row) => row.rank === 'preferred') ? 'preferred' : 'normal';
    return rows.filter((row) => row.rank === rank);
  };
  let original: string | undefined;
  for (const property of ['schema:name', 'schema:inLanguage']) {
    for (const row of ranked(property)) {
      const value = record(row.value) && row.value.type === 'value' ? row.value.content : undefined;
      const language = property === 'schema:name' && record(value) ? value.language : value;
      if (typeof language === 'string' && /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|[0-9]{3}))?$/.test(language)) {
        original = language;
        break;
      }
    }
    if (original) break;
  }
  return properties.flatMap((property) => {
    const rows = ranked(property).flatMap((row) => {
      if (
        !record(row.property) ||
        row.property.id !== property ||
        row.property.data_type !== 'document' ||
        !record(row.value) ||
        row.value.type !== 'value'
      )
        return [];
      const value = row.value.content;
      if (
        !record(value) ||
        typeof row.id !== 'string' ||
        !uuid.test(row.id) ||
        typeof value.document !== 'string' ||
        !uuid.test(value.document) ||
        typeof value.digest !== 'string' ||
        !/^[0-9a-f]{64}$/.test(value.digest) ||
        typeof value.language !== 'string'
      )
        return [];
      return [{ candidate: row.id, document: value.document, digest: value.digest, language: value.language }];
    });
    const language = pickLanguage(
      rows.map((row) => row.language),
      locale,
      original,
    );
    const selected = rows
      .filter((row) => row.language === language)
      .sort((left, right) => (left.candidate < right.candidate ? -1 : left.candidate > right.candidate ? 1 : 0))[0];
    return selected ? [selected] : [];
  });
}
