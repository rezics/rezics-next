import type { Release } from '@rezics/definitions';
import type { CommandTransaction } from '../command/command.ts';
import { routeOf } from '../route/route.ts';
import type { IndexedStatement } from '../search/source.ts';

export const erasedStatementAgentsSql = `SELECT id::text FROM unnest($1::uuid[]) AS requested(id)
 WHERE semantic.search_agent_erased(get_byte(uuid_send(id),10)*256+get_byte(uuid_send(id),11),id)`;
export const STATEMENT_AGENT_PAGE = 256;

/** Relation and credit readers disclose their targets separately. Descriptive item values and
 * qualifiers can also identify a personal agent. Test only the native IDs in the admitted window. */
export async function withoutErasedStatementAgents<T extends { statement: IndexedStatement; release: Release }>(
  tx: CommandTransaction,
  entries: readonly T[],
): Promise<readonly T[]> {
  const references = entries.map(({ statement, release }) => {
    const ids: string[] = [];
    if (statement.facet?.kind === 'item') ids.push(statement.value);
    for (const q of statement.qualifiers ?? [])
      if (release.properties[q.property]?.datatype === 'wikibase-item') ids.push(q.value);
    return ids.filter((id) => id[14] === '8' && routeOf(id) !== null);
  });
  const ids = [...new Set(references.flat())];
  if (!ids.length) return entries;
  const erased = new Set<string>();
  for (let offset = 0; offset < ids.length; offset += STATEMENT_AGENT_PAGE) {
    const page = ids.slice(offset, offset + STATEMENT_AGENT_PAGE);
    const { rows } = await tx.query<{ id: string }>(erasedStatementAgentsSql, [page]);
    for (const { id } of rows) erased.add(id);
  }
  return entries.filter((_, i) => !references[i]!.some((id) => erased.has(id)));
}
