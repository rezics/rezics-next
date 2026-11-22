import type { Pool } from 'pg';
import { nativeSourceQuery } from '../database/native-source-query.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type { IndexedSubject, SubjectSnapshot } from '../search/source.ts';
import { withReadStatement } from './read.ts';
import readTerms from './search-catalogue-terms.sql';

type TermRow = { kind: string; language: string | null; operation: string; body: unknown };
type TermTuple = [string, string | null, string, unknown];

function termValues(rows: TermRow[], kind: 'label' | 'description' | 'alias') {
  const current = new Map<string, string>();
  const aliases = new Map<string, string[]>();
  for (const row of rows) {
    if (row.kind !== kind || row.language === null || typeof row.body !== 'string') continue;
    if (kind === 'alias') {
      const values = aliases.get(row.language) ?? [];
      const index = values.indexOf(row.body);
      if (row.operation === 'retract') {
        if (index >= 0) values.splice(index, 1);
      } else if (index < 0) values.push(row.body);
      aliases.set(row.language, values);
    } else if (row.operation === 'retract') current.delete(row.language);
    else current.set(row.language, row.body);
  }
  if (kind === 'alias')
    return [...aliases].flatMap(([language, values]) => values.map((value) => ({ language, value })));
  return [...current].map(([language, value]) => ({ language, value }));
}

export function currentTerms(facts: TermRow[]) {
  const byLanguage = (a: { language: string }, b: { language: string }) =>
    a.language < b.language ? -1 : a.language > b.language ? 1 : 0;
  return {
    labels: termValues(facts, 'label').sort(byLanguage),
    aliases: termValues(facts, 'alias').sort(byLanguage),
    descriptions: termValues(facts, 'description').sort(byLanguage),
  };
}

/** A ready candidate with no selected statements has only native terms for current
 * text, match evidence and display. Wider windows use the complete Subject reader. */
export async function readCatalogueTextCandidate(pool: Pool, id: string): Promise<SubjectSnapshot | null> {
  const route = routeOf(id);
  if (route === null) throw new TypeError('A catalogue candidate must have a routed Subject ID');
  const partition = partitionOf(route);
  const [row] = await withReadStatement(pool, (client) =>
    nativeSourceQuery(
      client,
      readTerms,
      { partition_no: partition, subject_id: id, route },
      { name: 'semantic_catalogue_terms_one_v1' },
    ),
  );
  if (!row || row.home === 'moved') return null;
  const position = BigInt(row.position);
  if (row.type === null) return { partition, position, subjects: [] };
  const raw = (row.facts ?? []) as TermTuple[];
  if (!row.ready || row.selected || raw.length > 64) return null;
  const facts = raw.map(([kind, language, operation, body]) => ({ kind, language, operation, body }));
  return {
    partition,
    position,
    subjects: [
      {
        id,
        type: row.type,
        visibility: row.redirect ? 'hidden' : (row.visibility as IndexedSubject['visibility']),
        redirect: row.redirect,
        securityRevision: Number(row.revision),
        ...currentTerms(facts),
        statements: [],
      },
    ],
  };
}
