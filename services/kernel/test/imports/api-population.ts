import { bundledDigest } from '@rezics/definitions/bundled';
import { derivedId, partitionOf, routeOf } from '../../src/route/route.ts';
import { tupleRoute } from '../../src/content/imported-contract.ts';
import { seed, placement, type Population } from '../support/growth.ts';
import { createGrowthLedgerPopulation } from './growth-ledger-population.ts';
import { createSubjectHistoryPopulation } from './growth-subject-history.ts';
import type { Source } from '../../../../specs/imports-api-driver.ts';
import type { ApiRuntime } from './api-runtime.ts';

/** Performance data only: disjoint native keys, one placement algorithm at every scale. */
export function createApiPopulation(runtime: ApiRuntime) {
  const seedLedger = createGrowthLedgerPopulation(runtime.importer.session.store.database);
  let catalogue = 0;
  let history = 0;
  let revisionHistory = 0;
  let revisionOffset = 0;
  let historySubjects = false;
  let target = { catalogueRecords: 0, historyRows: 0 };
  const hot = tupleRoute(runtime.identity.routeKey, 'bangumi', '1');
  const accountRoute = routeOf(runtime.identity.bulk.accountId)!;
  const stableId = (route: number, name: string) => derivedId('00000000-0000-8000-8000-000000000099', name, route);
  // Populate the history relation the native retraction provenance join reads.
  // Thirty-two revisions per ordinal give it thousands of rows at the first scale.
  const revisionsPerOrdinal = 32;
  function unrelatedRecord(source: Source, ordinal: number): unknown {
    const n = 1000000 + ordinal;
    if (source === 'bangumi') return { id: n, type: 1, name: `Unrelated ${n}` };
    if (source === 'openlibrary')
      return { key: `/works/OL${n}W`, type: { key: '/type/work' }, title: `Unrelated ${n}`, revision: 1 };
    if (source === 'vndb')
      return {
        vn: { id: `v${n}`, olang: 'en' },
        vn_titles: [{ id: `v${n}`, lang: 'en', official: true, title: `Unrelated ${n}`, latin: null }],
        entry_meta: { id: `v${n}`, revision: 1 },
        vn_extlinks: [],
        extlinks: [],
      };
    return {
      id: `Q${n}`,
      type: 'item',
      lastrevid: n,
      labels: { en: { language: 'en', value: `Unrelated ${n}` } },
      claims: {},
    };
  }
  const population: Population = {
    name: 'native-import-api-catalogue-and-account-history',
    hotPartition: partitionOf(hot),
    rows({ ordinal, route }) {
      const result: Record<string, Record<string, unknown>[]> = {};
      if (ordinal < target.catalogueRecords && ordinal >= catalogue) {
        result['semantic.subject'] = [route, hot].map((r, i) => ({
          route: r,
          subject_id: stableId(r, `subject:${ordinal}:${i}`),
          type: 'schema:Book',
          recorded_transaction_id: stableId(r, `transaction:${ordinal}:${i}`),
        }));
      }
      if (ordinal < target.historyRows && ordinal >= revisionHistory) {
        if (!historySubjects && ordinal === 0)
          result['semantic.subject'] = [
            ...(result['semantic.subject'] ?? []),
            ...historyRoutes.map((route) => ({
              route,
              subject_id: stableId(route, 'history-subject'),
              type: 'schema:Book',
              recorded_transaction_id: stableId(route, 'history-subject-transaction'),
            })),
          ];
        result['semantic.revision'] = historyRoutes.flatMap((route) =>
          Array.from({ length: revisionsPerOrdinal }, (_, index) => ({
            route,
            subject_id: stableId(route, 'history-subject'),
            revision: (revisionOffset + ordinal) * revisionsPerOrdinal + index + 1,
            kind: 'propose',
            release: bundledDigest,
            recorded_transaction_id: stableId(route, `history-revision:${revisionOffset + ordinal}:${index}`),
            source: null,
          })),
        );
      }
      if (ordinal < target.historyRows && ordinal >= history) {
        result['editorial.write_basis'] = [...new Set([route, hot, accountRoute])].map((r, i) => ({
          partition_no: partitionOf(r),
          transaction_id: stableId(r, `basis:${ordinal}:${i}`),
          epoch: 1,
          position: 1000000000 + ordinal * 4 + i,
          principal_kind: 'account',
          principal_id: runtime.identity.bulk.accountId,
          client_id: runtime.identity.client.clientId,
          requested_by: null,
        }));
      }
      return result;
    },
  };
  // Every record in the bounded five-record catalogue can be the removal
  // target. Its source tuple places the native subject's provenance join.
  const historyRoutes = [
    ...new Set(
      Array.from({ length: 5 }, (_, index) => tupleRoute(runtime.identity.routeKey, 'bangumi', String(index + 1))),
    ),
  ];
  return {
    population,
    seedSubjects: createSubjectHistoryPopulation(runtime.database),
    async seed(input: { catalogueRecords: number; historyRows: number }, ledgerSource = 'bangumi') {
      return runtime.time(`seed: ${input.catalogueRecords}/${input.historyRows}`, async () => {
        // Repeated growth checks start at their first scale again. Remove only
        // this population's disjoint setup keys before growing the next sample.
        // Native revisions are immutable. A new growth sequence appends its own
        // disjoint range, retaining all history from the preceding sequence.
        if (input.historyRows < revisionHistory) {
          revisionOffset += revisionHistory;
          revisionHistory = 0;
        }
        for (let ordinal = input.catalogueRecords; ordinal < catalogue; ordinal++) {
          const { route } = placement(population, ordinal);
          for (const [i, r] of [route, hot].entries())
            await runtime.database.admin.query('DELETE FROM semantic.subject WHERE route=$1 AND subject_id=$2', [
              r,
              stableId(r, `subject:${ordinal}:${i}`),
            ]);
        }
        for (let ordinal = input.historyRows; ordinal < history; ordinal++) {
          const { route } = placement(population, ordinal);
          for (const [i, r] of [...new Set([route, hot, accountRoute])].entries())
            await runtime.database.admin.query(
              'DELETE FROM editorial.write_basis WHERE partition_no=$1 AND transaction_id=$2',
              [partitionOf(r), stableId(r, `basis:${ordinal}:${i}`)],
            );
        }
        catalogue = Math.min(catalogue, input.catalogueRecords);
        history = Math.min(history, input.historyRows);
        target = input;
        await seed(runtime.database, population, {
          from: Math.min(catalogue, history, revisionHistory),
          to: Math.max(input.catalogueRecords, input.historyRows),
        });
        if (input.historyRows > 0) historySubjects = true;
        revisionHistory = input.historyRows;
        seedLedger(input, ledgerSource);
        catalogue = Math.max(catalogue, input.catalogueRecords);
        history = Math.max(history, input.historyRows);
        return { unrelatedRecord };
      });
    },
  };
}
