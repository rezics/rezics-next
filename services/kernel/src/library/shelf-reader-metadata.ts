import { EMPTY_SHELF_GENERATION } from './shelf-maintenance-ops-contract.ts';
import {
  ENTRY_STATES,
  type ShelfFacetReader,
  type ShelfReadGenerationReader,
  type ShelfSummary,
  type ShelfSummaryReader,
  type ShelfTab,
} from './shelf-contract.ts';
import { ShelfReadUnavailableError } from './shelf-reader-unavailable.ts';
import summaryRows from './shelf-reader-summary.sql';
import facetRows from './shelf-reader-facets.sql';
import valueRows from './shelf-reader-values.sql';

function count(text: string): number {
  const value = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(value))
    throw new ShelfReadUnavailableError('maintained count outside the transport integer range');
  return value;
}

/**
 * The installed shelf_count relation has no generation column yet. Its rows may be served only when the native
 * gate proves that the complete active generation is nil. A different generation needs the producer's real DDL,
 * rather than a guessed column or a silent fallback to old counters.
 */
export function createShelfMetadataReaders(
  generation: ShelfReadGenerationReader,
): ShelfSummaryReader & ShelfFacetReader {
  async function current(...args: Parameters<ShelfReadGenerationReader>) {
    const state = await generation(...args);
    if (state.readiness !== 'ready' || state.activeGeneration === null)
      throw new ShelfReadUnavailableError('native complete shelf generation');
    if (state.activeGeneration !== EMPTY_SHELF_GENERATION)
      throw new ShelfReadUnavailableError('generation-keyed shelf_count native storage binding');
  }
  return {
    async summary(client, route, accountId, typeId) {
      await current(client, { route, accountId });
      return readShelfSummary(client, route, accountId, typeId);
    },
    async types(client, route, accountId, after, limit, byteBudget) {
      await current(client, { route, accountId });
      return readShelfFacets(client, route, accountId, after, limit, byteBudget);
    },
  };
}

/** Native current-table reader. Caller owns admission and complete nil-generation evidence in this snapshot. */
export const readShelfSummary: ShelfSummaryReader['summary'] = async (client, route, accountId, typeId) => {
  const rows = await summaryRows.run(
    { query: client.query.bind(client) },
    { route, account_id: accountId, type_id: typeId },
  );
  const tabs = Object.fromEntries(
    ['all', ...ENTRY_STATES, 'collections'].map((tab) => [tab, { total: 0, shown: 0 }]),
  ) as ShelfSummary['tabs'];
  for (const row of rows) {
    const tab = row.bucket as ShelfTab;
    if (!Object.hasOwn(tabs, tab)) throw new ShelfReadUnavailableError('maintained shelf bucket');
    const n = count(row.n);
    if (row.typeId === EMPTY_SHELF_GENERATION) tabs[tab].total = n;
    else tabs[tab].shown = n;
  }
  if (typeId === null) for (const tab of Object.values(tabs)) tab.shown = tab.total;
  tabs.collections.shown = tabs.collections.total;
  return { tabs };
};

/** Native discovery/value reader, under the same admitted complete nil-generation snapshot. */
export const readShelfFacets: ShelfFacetReader['types'] = async (
  client,
  route,
  accountId,
  after,
  limit,
  byteBudget,
) => {
  const rows = await facetRows.run(
    { query: client.query.bind(client) },
    {
      route,
      account_id: accountId,
      after: after ?? EMPTY_SHELF_GENERATION,
      take: limit + 1,
    },
  );
  // Missing dictionary evidence invalidates the page, including a discovered lookahead key.
  if (rows.some((row) => row.jsonBytes === null))
    throw new ShelfReadUnavailableError('complete private type dictionary');
  const selected: { typeId: string; n: number }[] = [];
  // Reserve the maximum 4096-byte cursor plus JSON envelope, escaping, separators and count fields.
  let bytes = 4224;
  for (const row of rows.slice(0, limit)) {
    const n = count(row.n);
    const valueBytes = count(row.jsonBytes!);
    const itemBytes = valueBytes + String(n).length + 20;
    if (bytes + itemBytes > byteBudget) break;
    bytes += itemBytes;
    selected.push({ typeId: row.typeId, n });
  }
  if (rows.length > 0 && selected.length === 0) throw new ShelfReadUnavailableError('type response byte budget');
  const values =
    selected.length === 0
      ? []
      : await valueRows.run(
          { query: client.query.bind(client) },
          {
            route,
            account_id: accountId,
            type_ids: selected.map((row) => row.typeId),
          },
        );
  const dictionary = new Map(values.map((row) => [row.typeId, row.type]));
  const types = selected.map((row) => {
    const type = dictionary.get(row.typeId);
    if (type === undefined) throw new ShelfReadUnavailableError('complete private type dictionary');
    return { type, count: row.n };
  });
  return { types, more: rows.length > selected.length, after: selected.at(-1)?.typeId ?? null };
};
