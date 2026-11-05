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
