import type { Pool } from 'pg';
import { CommandUnavailableError, type CommandTransaction } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { partitionOf } from '../route/route.ts';
import { sealHistoryAccount } from './gates.ts';
import { decodeLocator } from './locator.ts';
import type { HistoryArtifactType } from './contracts.ts';
import { commandHistoryKind } from './record.ts';
import { lockHistoryBarrier, recordHistoryFamilyArtifactWatch } from './receiving.ts';
import type { HistoryBarrier, HistoryFamilySource, HistoryProducerFamily, HistoryRegistry } from './registry.ts';
import { nativeHistoryProducerFamily } from './registry.ts';

export const HISTORY_FAMILY_PAGE = 100;
export type HistoryFamilyProgress = Readonly<{ state: 'more' | 'pending' | 'complete'; gap?: string }>;
type Progress = {
  barrier_version: number;
  barrier_at: string;
  definition_digest: string;
  domain_generation: string;
  fence_revision: string;
  partition_cursor: number;
  current_partition: number | null;
  artifact_type: HistoryArtifactType | null;
  locator: Buffer | null;
  phase: string;
  gap: string | null;
};

export async function installHistoryFamilyDefinitions(
  tx: CommandTransaction,
  registry: HistoryRegistry,
): Promise<void> {
  for (const definition of registry.familyDefinitions()) {
    await tx.query(
      `INSERT INTO core.history_family_definition(family,version,digest,sources,registry_digest) VALUES($1,$2,$3,$4,$5)
       ON CONFLICT(family) DO UPDATE SET version=EXCLUDED.version,digest=EXCLUDED.digest,
         sources=EXCLUDED.sources,registry_digest=EXCLUDED.registry_digest,admit_cursor=NULL,admission_complete=false
       WHERE core.history_family_definition.digest<>EXCLUDED.digest OR core.history_family_definition.registry_digest<>EXCLUDED.registry_digest`,
      [definition.family, definition.version, definition.digest, JSON.stringify(definition.sources), registry.digest()],
    );
  }
}

/** Owner input is native enrollment, not a callback: every current/former producer, each
 * configured physical home, original erasure root, source cut/version, and a sealed role prefix.
 * No enrollment is manufactured by this worker, including for empty physical prefixes. */
export async function advanceHistoryFamilyCoverage(
  deps: Readonly<{ pool: Pool }>,
  barrier: HistoryBarrier,
  family: HistoryProducerFamily,
): Promise<HistoryFamilyProgress> {
  return withConnection(deps.pool, async (tx) => {
    await tx.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    try {
      await tx.query("SET LOCAL statement_timeout='2s'");
      await tx.query("SET LOCAL lock_timeout='200ms'");
      const domain = (
        await tx.query<{ generation: string }>(
          'SELECT generation FROM core.history_family_domain WHERE singleton FOR SHARE',
        )
      ).rows[0]!;
      if (!(await lockHistoryBarrier(tx, barrier))) throw new TypeError('History barrier mismatch');
      const definition = (
        await tx.query<{ digest: string; registry_digest: string; sources: HistoryFamilySource[] }>(
          'SELECT digest,registry_digest,sources FROM core.history_family_definition WHERE family=$1 FOR SHARE',
          [family],
        )
      ).rows[0];
      if (!definition) {
        await tx.query('COMMIT');
        return { state: 'pending', gap: `${family}:native-producer-inventory-unavailable` };
      }
      await tx.query(
        `INSERT INTO core.history_family_fence(account_route,account_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,
        [barrier.accountRoute, barrier.accountId],
      );
      const fence = (
        await tx.query<{ revision: string }>(
          'SELECT revision FROM core.history_family_fence WHERE account_route=$1 AND account_id=$2 FOR UPDATE',
          [barrier.accountRoute, barrier.accountId],
        )
      ).rows[0]!;
      const key = [family, barrier.accountRoute, barrier.accountId];
      await tx.query(
        `INSERT INTO core.history_family_coverage(family,account_route,account_id,barrier_version,barrier_at,
          definition_digest,domain_generation,fence_revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
        [...key, barrier.version, barrier.at, definition.digest, domain.generation, fence.revision],
      );
      const job = (
        await tx.query<Progress>(
          'SELECT * FROM core.history_family_coverage WHERE family=$1 AND account_route=$2 AND account_id=$3 FOR UPDATE',
          key,
        )
      ).rows[0]!;
      if (job.barrier_version !== barrier.version || job.barrier_at !== barrier.at)
        throw new TypeError('History family immutable root mismatch');
      if (
        job.domain_generation !== domain.generation ||
        job.fence_revision !== fence.revision ||
        job.definition_digest !== definition.digest
      ) {
        await tx.query(
          `UPDATE core.history_family_coverage SET partition_cursor=-1,current_partition=NULL,artifact_type=NULL,
            locator=NULL,phase='scan',gap=NULL,proof_id=NULL,definition_digest=$4,domain_generation=$5,fence_revision=$6
           WHERE family=$1 AND account_route=$2 AND account_id=$3`,
          [...key, definition.digest, domain.generation, fence.revision],
        );
        job.partition_cursor = -1;
        job.current_partition = null;
        job.artifact_type = null;
        job.locator = null;
        job.phase = 'scan';
        job.gap = null;
      }
      let answer: HistoryFamilyProgress;
      const registry = (
        await tx.query<{ gaps: string[]; digest: string }>(
          'SELECT gaps,digest FROM core.history_registry WHERE singleton FOR SHARE',
        )
      ).rows[0];
      const gap = registry?.gaps.find((entry) => entry.startsWith(`${family}:`));
      if (!registry || gap) answer = { state: 'pending', gap: gap ?? 'producer-registry-unavailable' };
      else if (registry.digest !== definition.registry_digest)
        answer = { state: 'pending', gap: `${family}:native-producer-inventory-unavailable` };
      else if (job.phase === 'complete') {
        await tx.query('COMMIT');
        return { state: 'complete' };
      } else if (job.phase === 'pending') answer = { state: 'pending', gap: job.gap! };
      else answer = await segment(tx, barrier, family, definition, job);
      // Our own seal changes have the same native invalidation as any other writer. Only this
      // transaction holds the account's exclusive fence; adopt those changes with its checkpoint.
      await tx.query(
        `UPDATE core.history_family_coverage SET phase=$4,gap=$5,proof_id=$6,
          fence_revision=(SELECT revision FROM core.history_family_fence WHERE account_route=$2 AND account_id=$3),
          next_run=now() WHERE family=$1 AND account_route=$2 AND account_id=$3`,
        [
          ...key,
          answer.state === 'more' ? 'scan' : answer.state,
          answer.gap ?? null,
          answer.state === 'complete' ? Bun.randomUUIDv7() : null,
        ],
      );
      await tx.query('COMMIT');
      return answer;
    } catch (error) {
      await tx.query('ROLLBACK');
      throw error;
    }
  });
}

async function segment(
  tx: CommandTransaction,
  barrier: HistoryBarrier,
  family: HistoryProducerFamily,
  definition: { digest: string; sources: HistoryFamilySource[] },
  job: Progress,
): Promise<HistoryFamilyProgress> {
  const key = [family, barrier.accountRoute, barrier.accountId];
  const home = (
    await tx.query<{ partition_no: number; epoch: number; write_state: string }>(
      `SELECT partition_no,epoch,write_state FROM core.partition
     WHERE partition_no ${job.current_partition === null ? '>' : '='} $1 ORDER BY partition_no LIMIT 1 FOR SHARE`,
      [job.current_partition ?? job.partition_cursor],
    )
  ).rows[0];
  if (!home) {
    if (job.current_partition !== null) throw new CommandUnavailableError('moved', job.current_partition);
    // The local native domain cannot be empty: account-home is a required physical member.
    const accountHome = (
      await tx.query("SELECT 1 FROM core.partition WHERE partition_no=$1 AND write_state='active' FOR SHARE", [
        partitionOf(barrier.accountRoute),
      ])
    ).rows[0];
    if (!accountHome) throw new CommandUnavailableError('moved', partitionOf(barrier.accountRoute));
    return { state: 'complete' };
  }
  if (home.write_state !== 'active') throw new CommandUnavailableError('moved', home.partition_no);
  await sealHistoryAccount(tx, home.partition_no, barrier.accountRoute, barrier.accountId);
  const enrolled = (
    await tx.query<{
      artifact_type: HistoryArtifactType;
      producer: string;
      producer_version: number;
      definition_digest: string;
      barrier_version: number;
      barrier_at: string;
      partition_epoch: number;
    }>(
      `SELECT artifact_type,producer,producer_version,definition_digest,barrier_version,barrier_at,partition_epoch
     FROM core.history_family_enrollment WHERE family=$1 AND account_route=$2 AND account_id=$3 AND partition_no=$4
     ORDER BY artifact_type,producer LIMIT 101 FOR SHARE`,
      [...key, home.partition_no],
    )
  ).rows;
  for (const source of definition.sources) {
    const enrollment = enrolled.find(
      (row) => row.artifact_type === source.artifactType && row.producer === source.producer,
    );
    if (
      !enrollment ||
      enrollment.producer_version !== source.version ||
      enrollment.definition_digest !== definition.digest ||
      enrollment.barrier_version !== barrier.version ||
      enrollment.barrier_at !== barrier.at ||
      enrollment.partition_epoch !== home.epoch
    )
      return { state: 'pending', gap: `${family}:${source.artifactType}:${source.producer}:historical-enrollment` };
  }
  if (enrolled.length !== definition.sources.length)
    return { state: 'pending', gap: `${family}:historical-producer-inventory-changed` };
  const page = (
    await tx.query<{ artifact_type: HistoryArtifactType; locator: Buffer }>(
      `SELECT artifact_type,locator FROM core.history_locator
     WHERE partition_no=$1 AND account_route=$2 AND account_id=$3
       AND (artifact_type,locator)>($4::text COLLATE "C",$5::bytea)
     ORDER BY artifact_type,locator LIMIT 100`,
      [
        home.partition_no,
        barrier.accountRoute,
        barrier.accountId,
        job.artifact_type ?? '',
        job.locator ?? Buffer.alloc(0),
      ],
    )
  ).rows;
  for (const row of page) {
    const locator = decodeLocator(row.artifact_type, row.locator);
    const producer =
      locator.artifactType === 'command-receipt/v1'
        ? commandHistoryKind(locator.commandKindId)
        : locator.artifactType === 'outbox-event/v1'
          ? (
              await tx.query<{ type: string }>(
                'SELECT type FROM core.outbox WHERE partition_no=$1 AND position=$2 AND event_seq=$3 FOR SHARE',
                [home.partition_no, locator.position.toString(), locator.eventSeq],
              )
            ).rows[0]?.type
          : (
              await tx.query<{ owner: string | null }>(
                'SELECT owner FROM core.history_work WHERE partition_no=$1 AND work_id=$2 FOR SHARE',
                [home.partition_no, locator.workId],
              )
            ).rows[0]?.owner;
    if (!producer) return { state: 'pending', gap: `${family}:${row.artifact_type}:native-producer-unresolved` };
    if (
      !definition.sources.some((source) => source.artifactType === row.artifact_type && source.producer === producer)
    ) {
      const producerFamily = nativeHistoryProducerFamily(producer);
      if (producerFamily === family)
        return { state: 'pending', gap: `${family}:${row.artifact_type}:${producer}:historical-producer-missing` };
      if (producerFamily !== undefined) continue;
      const foreign = (
        await tx.query<{ family: string }>(
          `SELECT family FROM core.history_family_definition WHERE family<>$1 AND sources @> $2::jsonb LIMIT 2 FOR SHARE`,
          [family, JSON.stringify([{ artifactType: row.artifact_type, producer }])],
        )
      ).rows;
      if (foreign.length === 1) continue;
      return { state: 'pending', gap: `${family}:${row.artifact_type}:native-producer-unresolved` };
    }
    const roles = (
      await tx.query<{ account_route: number; account_id: string; roles: number }>(
        `SELECT account_route,account_id,roles FROM core.history_locator WHERE partition_no=$1 AND artifact_type=$2 AND locator=$3
       ORDER BY account_route,account_id LIMIT 65 FOR SHARE`,
        [home.partition_no, row.artifact_type, row.locator],
      )
    ).rows;
    if (
      roles.length > 64 ||
      !(await recordHistoryFamilyArtifactWatch(tx, barrier, {
        partition: home.partition_no,
        locator,
        accounts: roles.map((ref) => ({
          accountRoute: ref.account_route,
          accountId: ref.account_id,
          roles: ref.roles,
        })),
      }))
    )
      return { state: 'pending', gap: `${family}:${row.artifact_type}:receiving-custody` };
  }
  const last = page.at(-1);
  if (last && page.length === HISTORY_FAMILY_PAGE) {
    await tx.query(
      `UPDATE core.history_family_coverage SET current_partition=$4,artifact_type=$5,locator=$6
       WHERE family=$1 AND account_route=$2 AND account_id=$3`,
      [...key, home.partition_no, last.artifact_type, last.locator],
    );
  } else {
    await tx.query(
      `UPDATE core.history_family_coverage SET partition_cursor=$4,current_partition=NULL,artifact_type=NULL,locator=NULL
       WHERE family=$1 AND account_route=$2 AND account_id=$3`,
      [...key, home.partition_no],
    );
  }
  return { state: 'more' };
}
