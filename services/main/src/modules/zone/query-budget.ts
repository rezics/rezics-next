import type { ZoneConfiguration } from './config-format.ts';

export class ZoneQueryBudgetExceeded extends Error {}

/** One request also shares the public-search owner's 72 Fuseki calls and 8 MiB read ceiling. */
export const ZONE_QUERY_COST = { maxBlocks: 32, maxFusekiCalls: 72,
  maxFusekiBytes: 8_388_608 } as const;

export interface ZoneQueryResult {
  total: number;
  members: { work: string; selection: string }[];
  coverage: 'complete' | 'partial';
  sourcePosition: { datasetId: 'product'; dataEpoch: string; sequence: string };
}

/** All nested Blocks debit one request ledger. A child cannot reset the row or time ceiling. */
export async function runZoneQueryBlocks(config: ZoneConfiguration,
  query: (definition: string) => Promise<ZoneQueryResult>, now = Date.now) {
  const deadline = now() + config.budget.timeMs;
  let rowsLeft = config.budget.rows;
  const results: Array<{ block: string; parent?: string; state: 'complete' | 'partial' | 'skipped';
    members: ZoneQueryResult['members']; sourcePosition?: ZoneQueryResult['sourcePosition'] }> = [];
  for (const block of config.queryBlocks) {
    if (rowsLeft === 0 || now() >= deadline) {
      results.push({ block: block.block, ...(block.parent ? { parent: block.parent } : {}),
        state: 'skipped', members: [] });
      continue;
    }
    const relation = await query(block.definition);
    if (now() >= deadline) throw new ZoneQueryBudgetExceeded('Zone query time budget exceeded');
    const allowance = Math.min(block.maxRows, rowsLeft);
    const members = relation.members.slice(0, allowance);
    rowsLeft -= members.length;
    results.push({ block: block.block, ...(block.parent ? { parent: block.parent } : {}),
      state: relation.coverage === 'complete' && relation.total <= members.length
        ? 'complete' : 'partial', members, sourcePosition: relation.sourcePosition });
  }
  return { results, cost: { blocksConfigured: config.queryBlocks.length,
    blocksExecuted: results.filter(item => item.state !== 'skipped').length,
    rowsReturned: config.budget.rows - rowsLeft, rowBudget: config.budget.rows,
    timeBudgetMs: config.budget.timeMs } };
}
