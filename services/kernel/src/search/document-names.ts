import type { IndexedSubject } from './source.ts';

export type PublicName = { field: 'title' | 'alias'; language: string; value: string };

/**
 * Terms select presentation; adopted name statements also supply searchable text.
 * Reuse the complete public statement snapshot, without another reader or writer.
 * Native slot/candidate and monolingual field limits bound this traversal.
 */
export function* publicNames(subject: IndexedSubject): Generator<PublicName> {
  for (const name of subject.labels) yield { field: 'title', ...name };
  for (const name of subject.aliases) yield { field: 'alias', ...name };
  for (const statement of subject.statements) {
    if (statement.language === undefined) continue;
    if (statement.property === 'schema:name')
      yield { field: 'title', language: statement.language, value: statement.value };
    else if (statement.property === 'schema:alternateName')
      yield { field: 'alias', language: statement.language, value: statement.value };
  }
}

/**
 * Display aliases grouped by stored language, native order, exact-value unique.
 * Reader locale selects among these later; matched alias language is not a filter.
 */
export function publicAliases(subject: IndexedSubject): Record<string, string[]> {
  const aliasesByLanguage = new Map<string, string[]>();
  const seen = new Map<string, Set<string>>();
  for (const alias of subject.aliases) {
    const unique = seen.get(alias.language) ?? new Set<string>();
    if (unique.has(alias.value)) continue;
    unique.add(alias.value);
    seen.set(alias.language, unique);
    const values = aliasesByLanguage.get(alias.language) ?? [];
    values.push(alias.value);
    aliasesByLanguage.set(alias.language, values);
  }
  return Object.fromEntries([...aliasesByLanguage].sort(([left], [right]) => left.localeCompare(right)));
}
