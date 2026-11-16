import type { Pool } from 'pg';
import { IdentityEpochStoreError } from '../semantic/contract/identity-errors.ts';
import type { IdentityChange, IdentityJobRef } from '../semantic/identity-adapters/index.ts';
import type { SearchIdentityReceivingSelection } from '../semantic/identity-receiving-effects.ts';
import { withReadTransaction } from '../semantic/read.ts';
import type { SearchNativeReceivingPreparation } from './identity-receiving-native-internal.ts';
import type { SearchReceivingConfiguration } from './identity-receiving-native.ts';
import { subjectPartition } from './source.ts';
import { readSearchIdentityOriginalPlanSql } from './identity-search-receiving-directory-sql.ts';

const unavailable = (detail: string) => new IdentityEpochStoreError('identity_epoch_unavailable', detail);

function effectKey(consumer: string, original: string, disposition: SearchIdentityReceivingSelection['disposition']) {
  return `${consumer}:${original}:${disposition}`;
}

export async function readSearchIdentityOriginalPlan(
  pool: Pool,
  job: IdentityJobRef,
  change: IdentityChange,
  configuration: SearchReceivingConfiguration,
  deadline: number,
): Promise<SearchIdentityReceivingSelection | null> {
  const partition = subjectPartition(change.original);
  const keys = (['OLD', 'NEW', 'first-apply', 'handoff'] as const).map((disposition) =>
    effectKey(configuration.consumer, change.original, disposition),
  );
  const plans = await withReadTransaction(
    pool,
    async (tx) =>
      (
        await tx.query<{ effect_key: string; source: SearchNativeReceivingPreparation['source']; proven: boolean }>(
          readSearchIdentityOriginalPlanSql,
          [partition, job.jobId, String(job.epoch), keys, change.original, configuration.index],
        )
      ).rows,
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
    plan.effect_key !== effectKey(source.consumer, source.original, source.disposition)
  )
    throw unavailable('Retained Search plan changed for the selected original');
  return {
    job,
    original: source.original,
    effectKey: plan.effect_key,
    owner: source.owner,
    sourceId: source.sourceId,
    scope: source.scope,
    disposition: source.disposition,
    native: source.locator,
  };
}
