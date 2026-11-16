import type { Pool } from 'pg';
import { IdentityEpochStoreError } from '../semantic/contract/identity-errors.ts';
import type { IdentityChange, IdentityJobRef } from '../semantic/identity-adapters/index.ts';
import type { SearchIdentityReceivingSelection } from '../semantic/identity-receiving-effects.ts';
import { withReadTransaction } from '../semantic/read.ts';
import type { SearchNativeReceivingPreparation } from './identity-receiving-native-internal.ts';
import type { SearchReceivingConfiguration } from './identity-receiving-native.ts';
import { subjectPartition } from './source.ts';
import {
  locateSearchIdentityOriginalPlanSql,
  readSearchIdentityOriginalPlanSql,
  searchIdentityOriginalPlanPresentSql,
} from './identity-search-receiving-directory-sql.ts';

const unavailable = (detail: string) => new IdentityEpochStoreError('identity_epoch_unavailable', detail);

export function searchIdentityWriterEffectKey(
  consumer: string,
  original: string,
  disposition: SearchIdentityReceivingSelection['disposition'],
) {
  return `${consumer}:${original}:${disposition}`;
}

function originalPlanBinds(job: IdentityJobRef, original: string, configuration: SearchReceivingConfiguration) {
  const keys = (['OLD', 'NEW', 'first-apply', 'handoff'] as const).map((disposition) =>
    searchIdentityWriterEffectKey(configuration.consumer, original, disposition),
  );
  return [subjectPartition(original), job.jobId, String(job.epoch), keys, original, configuration.index];
}

export async function locateSearchIdentityOriginalPlan(
  pool: Pool,
  job: IdentityJobRef,
  original: string,
  configuration: SearchReceivingConfiguration,
  deadline: number,
) {
  const rows = await withReadTransaction(
    pool,
    async (tx) => (
      await tx.query<{ plan_id: string; original_barrier: boolean }>(
        locateSearchIdentityOriginalPlanSql,
        originalPlanBinds(job, original, configuration),
      )
    ).rows,
    deadline,
  );
  if (rows.length > 1) throw unavailable('Retained Search plan changed for the selected original');
  return rows[0] ?? null;
}

export async function readSearchIdentityOriginalPlan(
  pool: Pool,
  job: IdentityJobRef,
  change: Pick<IdentityChange, 'original' | 'terminal'>,
  configuration: SearchReceivingConfiguration,
  deadline: number,
  mode?: 'preparation',
): Promise<Readonly<{
  selection: SearchIdentityReceivingSelection;
  originalBarrier: boolean;
}> | null> {
  const partition = subjectPartition(change.original);
  const binds = originalPlanBinds(job, change.original, configuration);
  const plans = await withReadTransaction(
    pool,
    async (tx) => {
      if (mode === 'preparation' && !(await tx.query(searchIdentityOriginalPlanPresentSql, binds)).rowCount) return [];
      return (
        await tx.query<{ effect_key: string; source: SearchNativeReceivingPreparation['source']; proven: boolean }>(
          readSearchIdentityOriginalPlanSql,
          binds,
        )
      ).rows;
    },
    deadline,
  );
  const plan = plans[0];
  if (!plan) return null;
  const { source } = plan;
  if (
    plans.length !== 1 ||
    !plan.proven ||
    source.receivingHome !== partition ||
    source.locator.partition !== partition ||
    source.original !== change.original ||
    source.terminal !== change.terminal ||
    source.consumer !== configuration.consumer ||
    source.physicalTarget !== configuration.index ||
    plan.effect_key !== searchIdentityWriterEffectKey(source.consumer, source.original, source.disposition)
  )
    throw unavailable('Retained Search plan changed for the selected original');
  return {
    originalBarrier: source.barrier.kind === 'original',
    selection: {
      job,
      original: source.original,
      effectKey: plan.effect_key,
      owner: source.owner,
      sourceId: source.sourceId,
      scope: source.scope,
      disposition: source.disposition,
      native: source.locator,
    },
  };
}
