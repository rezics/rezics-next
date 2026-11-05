import type { Pool } from 'pg';
import type { PublicFilterSourceFactory } from '../semantic/public-filter-source-contract.ts';
import { createPublicFilterSourceBinding } from '../semantic/public-filter-source-binding.ts';
import { publicFilterSource } from '../semantic/public-filter-source.ts';
import type { PublicFilterSourceDefinition } from '../semantic/public-filter-source-binding.ts';
import { ProblemError } from '../http/problem.ts';
import type { OpenSearch } from './opensearch.ts';
import type { SearchHit } from './query.ts';
import { createScopeOrderedNative } from './scope-ordered-native.ts';
import { scopeOrderedNameKey, validateScopeOrderedHit, type ScopeOrderedPreparation } from './scope-ordered.ts';
import type { ScopePreparationRecord, ScopeCaptureFrontier } from './scope-preparation-store.ts';
import type { IdentityScopeObservation } from '../semantic/identity-scope-types.ts';
import { ScopeWork, zeroScopeWork } from './scope-execution.ts';
import stateSql from './scope-ordered-state.sql';
import saveSql from './scope-ordered-save.sql';
import pageSql from './scope-ordered-page.sql';
import firstSql from './scope-ordered-first.sql';

function unready(): never {
  throw new ProblemError('semantic_not_ready');
}
export type OrderedPreparationConfig = Parameters<PublicFilterSourceFactory>[0] & {
  prefix: string;
  search: OpenSearch;
};

/** Extends the existing structural Source capture: one native window, settled keys and
 * its successor commit together. Neither a partial window nor an unknown predecessor advances.
 */
export function createOrderedScopePreparation(config: OrderedPreparationConfig) {
  const binding = createPublicFilterSourceBinding(config.pool, config.routeKey, config.access);
  const source = publicFilterSource(config);
  return {
    native(definition: PublicFilterSourceDefinition, record: ScopePreparationRecord) {
      if (!record.definition.ordered || record.definition.kind !== 'public') unready();
      return createScopeOrderedNative({
        ...config,
        binding,
        source,
        meaning: definition.meaning,
        definition: record.definition.ordered,
      });
    },
    async state(scope: string, work: ScopeWork): Promise<ScopeOrderedPreparation> {
      work.consume({ ...zeroScopeWork(), statements: 1 });
      const row = await stateSql.run(config.pool, { prefix: config.prefix, scope });
      work.consume({
        ...zeroScopeWork(),
        nativeRows: row ? 1 : 0,
        bytes: Buffer.byteLength(JSON.stringify(row ?? null)),
      });
      return (row?.ordered_state as ScopeOrderedPreparation | null) ?? { queried: null, repair: null, execution: null };
    },
    async save(
      record: ScopePreparationRecord,
      frontier: ScopeCaptureFrontier,
      state: ScopeOrderedPreparation,
      observation: IdentityScopeObservation | null,
      hits: readonly SearchHit[],
      work: ScopeWork,
      ready = false,
    ) {
      const order = record.definition.ordered;
      if (!order) unready();
      for (const hit of hits) validateScopeOrderedHit(order.nativeOrder, hit, order.index);
      const values = {
        prefix: config.prefix,
        scope: record.scope_id,
        revision: record.revision,
        ordered_state: JSON.stringify(state),
        frontier: JSON.stringify(frontier),
        observation: observation
          ? JSON.stringify({ ...observation, committedRevision: String(observation.committedRevision) })
          : null,
        state: ready ? 'ready' : 'capture',
        due: String(Date.now()),
        subjects: hits.map((h) => h.id),
        counts: hits.map((h) => (order.nativeOrder === 'collections' ? -(h.sort[0] as number) : 0)),
        names: hits.map((h) => scopeOrderedNameKey(h.sort[h.sort.length - 2] as string | null)),
        hits: hits.map((h) => Buffer.from(JSON.stringify(h))),
      };
      work.consume({ ...zeroScopeWork(), statements: 1, bytes: Buffer.byteLength(JSON.stringify(values)) });
      const saved = await saveSql.run(config.pool, values);
      // Indexed CAS + bounded unique-key writes, never returned-row count as examined work.
      work.consume({ ...zeroScopeWork(), nativeRows: 1 + hits.length });
      if (!saved) unready();
    },
  };
}

export async function readOrderedScopeRows(
  pool: Pool,
  prefix: string,
  scope: string,
  order: 'name' | 'collections',
  after: readonly (string | number | null)[] | null,
  size: number,
  work: ScopeWork,
): Promise<SearchHit[]> {
  if (!Number.isSafeInteger(size) || size < 1 || size > 101) throw new RangeError('Invalid ordered Scope seek');
  work.consume({ ...zeroScopeWork(), statements: 1 });
  const rows = after
    ? await pageSql.run(pool, {
        prefix,
        scope,
        count_key: order === 'collections' ? -(after[0] as number) : 0,
        name_key: scopeOrderedNameKey(after[after.length - 2] as string | null),
        subject: after[after.length - 1] as string,
        size,
      })
    : await firstSql.run(pool, { prefix, scope, size });
  work.consume({
    ...zeroScopeWork(),
    candidateKeys: rows.length,
    nativeRows: size,
    bytes: rows.reduce((n, row) => n + row.hit.length, 0),
  });
  return rows.map((row) => JSON.parse(Buffer.from(row.hit).toString('utf8')) as SearchHit);
}
