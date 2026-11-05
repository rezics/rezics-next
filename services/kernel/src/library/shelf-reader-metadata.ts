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

/** Complete native generation selected in the same RR snapshot as every counter and dictionary read. */
export function createShelfMetadataReaders(
  generation: ShelfReadGenerationReader,
): ShelfSummaryReader & ShelfFacetReader {
  async function current(...args: Parameters<ShelfReadGenerationReader>) {
    const state = await generation(...args);
    if (state.readiness !== 'ready' || state.activeGeneration === null)
      throw new ShelfReadUnavailableError('native complete shelf generation');
    return state.activeGeneration;
  }
  return {
    async summary(client, route, accountId, typeId) {
      const generationId = await current(client, { route, accountId });
      return readShelfSummary(client, route, accountId, typeId, generationId);
    },
    async types(client, route, accountId, after, limit, byteBudget) {
      const generationId = await current(client, { route, accountId });
      return readShelfFacets(client, route, accountId, after, limit, byteBudget, generationId);
    },
  };
}

/** Storage reader; caller owns admission and complete generation evidence. Nil remains the legacy fixture default. */
export const readShelfSummary = async (
  client: Parameters<ShelfSummaryReader['summary']>[0],
  route: number,
  accountId: string,
  typeId: string | null,
  generationId = EMPTY_SHELF_GENERATION,
): Promise<ShelfSummary> => {
  const rows = await summaryRows.run(
    { query: client.query.bind(client) },
    { route, account_id: accountId, type_id: typeId, generation_id: generationId },
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

/** Native discovery/value reader, under the same admitted complete generation snapshot. */
export const readShelfFacets = async (
  client: Parameters<ShelfFacetReader['types']>[0],
  route: number,
  accountId: string,
  after: string | null,
  limit: number,
  byteBudget: number,
  generationId = EMPTY_SHELF_GENERATION,
): Promise<Awaited<ReturnType<ShelfFacetReader['types']>>> => {
  const rows = await facetRows.run(
    { query: client.query.bind(client) },
    {
      route,
      account_id: accountId,
      generation_id: generationId,
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
            generation_id: generationId,
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
