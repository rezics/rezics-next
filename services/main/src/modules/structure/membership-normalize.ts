import { randomUUID } from 'node:crypto';
import { CommandRejected, FusekiClient } from '../../infrastructure/fuseki.ts';
import { type WorkActivationEnvironment } from '../work/activate.ts';

/** The native proof is conservative after writes, restart or physical compaction. */
export async function hasUnnormalizedMembership(
  fuseki: Pick<FusekiClient, 'membershipPreparationStatus'>,
): Promise<boolean> {
  return (await fuseki.membershipPreparationStatus()).needsPreparation;
}

type PreparationProgress = { complete: boolean; placements: number; receipts: string[] };

async function prepareTurns(
  env: WorkActivationEnvironment,
  maxBatches: number,
  deadline: number,
  signal: AbortSignal,
): Promise<PreparationProgress> {
  const receipts: string[] = [];
  let placements = 0;
  for (let batch = 0; batch < maxBatches && Date.now() < deadline; batch++) {
    const result = await env.fuseki.membershipPrepare({
      ...env.lineage, requestId: randomUUID(), deadline,
    }, signal);
    if (result.status === 'guard-unmatched') continue;
    if (result.status !== 'committed') throw new CommandRejected(result);
    placements += result.placements;
    receipts.push(...result.receipts);
    if (result.complete) return { complete: true, placements, receipts };
  }
  return { complete: false, placements, receipts };
}

/** Native tuple continuation and exact replay retain progress across preparation
 * interruptions. Every turn, including transport retries, shares one wall budget.
 */
export async function upgradeStoredMembership(env: WorkActivationEnvironment) {
  const deadline = Date.now() + 540_000;
  const signal = AbortSignal.timeout(540_000);
  let placements = 0;
  const receipts: string[] = [];
  while (Date.now() < deadline) {
    const result = await prepareTurns(env, 256, deadline, signal);
    placements += result.placements;
    receipts.push(...result.receipts);
    if (result.complete) return { complete: true as const, placements, receipts };
  }
  throw new Error(
    'Ordered membership upgrade exceeded its preparation budget; product processes must remain stopped',
  );
}

/** Closed offline representation repair; each turn examines at most 256 native
 * tuples and converts at most 24 placements. Exhaustion of native phases proves
 * completion. Heads, manifests and parent-local order keys remain unchanged.
 */
export async function normalizeStoredMembership(
  env: WorkActivationEnvironment,
  maxBatches = 256,
  deadline = Date.now() + 540_000,
): Promise<PreparationProgress> {
  if (!Number.isInteger(maxBatches) || maxBatches < 1 || maxBatches > 256) {
    throw new Error('membership normalization requires 1-256 write batches');
  }
  if (!Number.isSafeInteger(deadline) || deadline < 1) throw new Error('Invalid membership preparation deadline');
  return prepareTurns(env, maxBatches, deadline, AbortSignal.timeout(Math.max(0, deadline - Date.now())));
}

if (import.meta.main) {
  for (const name of [
    'FUSEKI_URL',
    'FUSEKI_COMMAND_TOKEN',
    'MAIN_DATA_EPOCH',
    'MAIN_ROUTING_EPOCH',
  ]) {
    if (!Bun.env[name]) throw new Error(`Membership normalization requires ${name}`);
  }
  const result = await normalizeStoredMembership({
    fuseki: new FusekiClient(Bun.env.FUSEKI_URL!, undefined, Bun.env.FUSEKI_COMMAND_TOKEN!),
    lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH!, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH! },
    objectDirectory: '.temp/membership-normalization',
  });
  console.log(JSON.stringify(result));
  if (!result.complete) process.exitCode = 2;
}
