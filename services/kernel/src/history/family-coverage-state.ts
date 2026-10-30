import type { CommandTransaction } from '../command/command.ts';
import { CommandUnavailableError } from '../command/command.ts';
import { partitionOf } from '../route/route.ts';
import { lockHistoryBarrier } from './receiving.ts';
import type { HistoryBarrier, HistoryProducerFamily } from './registry.ts';

export type NativeFamilyCoverage = Readonly<{
  proofId: string;
  domain: string;
  revision: string;
  definition: string;
}>;
export type NativeFamilyResult =
  | Readonly<{ state: 'pending'; gaps: readonly string[] }>
  | Readonly<{ state: 'complete'; binding: NativeFamilyCoverage }>;

/** Constant exact keys, locked until the caller's COMMIT. The account fence is also the
 * serialization point for native role/copy/receiving changes; the domain fences routing. */
export async function lockNativeFamilyCoverage(
  tx: CommandTransaction,
  barrier: HistoryBarrier,
  family: HistoryProducerFamily,
): Promise<NativeFamilyResult> {
  const pending = (gap: string): NativeFamilyResult => ({ state: 'pending', gaps: [gap] });
  const domain = (
    await tx.query<{ generation: string }>(
      'SELECT generation FROM core.history_family_domain WHERE singleton FOR SHARE',
    )
  ).rows[0];
  if (!domain) return pending('native-family-domain-unavailable');
  if (!(await lockHistoryBarrier(tx, barrier))) throw new TypeError('History barrier mismatch');
  const fence = (
    await tx.query<{ revision: string }>(
      'SELECT revision FROM core.history_family_fence WHERE account_route=$1 AND account_id=$2 FOR SHARE',
      [barrier.accountRoute, barrier.accountId],
    )
  ).rows[0];
  const definition = (
    await tx.query<{ digest: string; registry_digest: string }>(
      'SELECT digest,registry_digest FROM core.history_family_definition WHERE family=$1 FOR SHARE',
      [family],
    )
  ).rows[0];
  const registry = (
    await tx.query<{ gaps: string[]; digest: string }>(
      'SELECT gaps,digest FROM core.history_registry WHERE singleton FOR SHARE',
    )
  ).rows[0];
  if (!registry) return pending('producer-registry-unavailable');
  const gaps = registry.gaps.filter((gap) => gap.startsWith(`${family}:`));
  if (gaps.length) return { state: 'pending', gaps };
  if (!definition || definition.registry_digest !== registry.digest)
    return pending(`${family}:native-producer-inventory-unavailable`);
  if (!fence) return pending(`${family}:native-historical-enrollment-unavailable`);
  const home = (
    await tx.query<{ write_state: string }>('SELECT write_state FROM core.partition WHERE partition_no=$1 FOR SHARE', [
      partitionOf(barrier.accountRoute),
    ])
  ).rows[0];
  if (home?.write_state !== 'active') throw new CommandUnavailableError('moved', partitionOf(barrier.accountRoute));
  const coverage = (
    await tx.query<{
      proof_id: string | null;
      phase: string;
      gap: string | null;
      definition_digest: string;
      domain_generation: string;
      fence_revision: string;
      barrier_version: number;
      barrier_at: string;
    }>(
      `SELECT proof_id,phase,gap,definition_digest,domain_generation,fence_revision,barrier_version,barrier_at
     FROM core.history_family_coverage WHERE family=$1 AND account_route=$2 AND account_id=$3 FOR SHARE`,
      [family, barrier.accountRoute, barrier.accountId],
    )
  ).rows[0];
  if (!coverage) return pending(`${family}:native-family-progress-unavailable`);
  if (coverage.barrier_version !== barrier.version || coverage.barrier_at !== barrier.at)
    return pending(`${family}:native-root-changed`);
  if (
    coverage.definition_digest !== definition.digest ||
    coverage.domain_generation !== domain.generation ||
    coverage.fence_revision !== fence.revision
  )
    return pending(`${family}:native-family-version-changed`);
  if (coverage.phase !== 'complete' || !coverage.proof_id)
    return pending(coverage.gap ?? `${family}:native-family-progress-incomplete`);
  return {
    state: 'complete',
    binding: Object.freeze({
      proofId: coverage.proof_id,
      domain: domain.generation,
      revision: fence.revision,
      definition: definition.digest,
    }),
  };
}
