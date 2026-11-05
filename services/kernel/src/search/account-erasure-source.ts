import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { CommandTransaction } from '../command/command.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { withReadTransaction } from '../semantic/read.ts';
import { isAdmittedSearchPrefix } from './consumer-name.ts';
import { MAX_SUBJECT_GENERATIONS } from './indices.ts';

type AccountErasureSearchResult =
  | Readonly<{ state: 'pending'; gap: string }>
  | Readonly<{ state: 'observed'; digest: string }>;
export type AccountErasureSearchObservation = AccountErasureSearchResult &
  Readonly<{
    prefix: string;
    accountId: string;
    accountPartition: number;
    eventPosition: string;
  }>;

export type AccountErasureSearchReadiness = Readonly<{ state: 'pending'; gap: string }> | Readonly<{ state: 'ready' }>;

type AccountErasureSearchInput = Readonly<{
  accountId: string;
  accountPartition: number;
  eventPosition: bigint;
  prefix?: string;
}>;

type SearchCopyState = Readonly<{
  generation: string;
  indexUuid: string;
  incarnation: string;
  populationComplete: boolean;
  populationCertified: boolean;
  position: string;
  revision: string;
  deleted: boolean;
  settled: boolean;
}>;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Read Search's current Account enrollment through a released Source snapshot. This is only an
 * observation: History must compare it against the Account same-home transaction below.
 */
export async function observeAccountErasureSearch(
  pool: Pool,
  input: AccountErasureSearchInput,
  deadline: number,
): Promise<AccountErasureSearchObservation> {
  const prefix = input.prefix ?? process.env.KERNEL_SEARCH_PREFIX ?? 'rezics-';
  const result = await withReadTransaction(pool, (tx) => inspect(tx, { ...input, prefix }, false), deadline);
  return {
    ...result,
    prefix,
    accountId: input.accountId,
    accountPartition: input.accountPartition,
    eventPosition: input.eventPosition.toString(),
  };
}

/** Final same-home read. A released Source observation or Search locator is never completion by
 * itself; the exact active generations, certified populations and settled copies must still match.
 */
export async function verifyAccountErasureSearchObservation(
  tx: CommandTransaction,
  input: AccountErasureSearchInput,
  observation: AccountErasureSearchObservation,
): Promise<AccountErasureSearchReadiness> {
  const route = routeOf(input.accountId);
  if (route === null || typeof input.eventPosition !== 'bigint' || input.eventPosition < 0n)
    throw new TypeError('Account erasure Search readiness requires a native recovery key');
  if (input.accountPartition !== partitionOf(route))
    return { state: 'pending', gap: 'agent-identity-recovery-account-partition-unsupported' };
  if (
    observation.accountId !== input.accountId ||
    observation.accountPartition !== input.accountPartition ||
    observation.eventPosition !== input.eventPosition.toString()
  )
    return { state: 'pending', gap: 'agent-identity-recovery-search-currentness-changed' };
  if (observation.state === 'pending') return observation;
  const current = await inspect(tx, { ...input, prefix: observation.prefix }, true);
  if (current.state === 'pending') return current;
  return current.digest === observation.digest
    ? { state: 'ready' }
    : { state: 'pending', gap: 'agent-identity-recovery-search-currentness-changed' };
}

async function inspect(
  tx: CommandTransaction,
  input: AccountErasureSearchInput,
  lock: boolean,
): Promise<AccountErasureSearchResult> {
  const route = routeOf(input.accountId);
  if (route === null || typeof input.eventPosition !== 'bigint' || input.eventPosition < 0n)
    throw new TypeError('Account erasure Search readiness requires a native recovery key');
  const home = partitionOf(route);
  if (input.accountPartition !== home)
    return { state: 'pending', gap: 'agent-identity-recovery-account-partition-unsupported' };

  const prefix = input.prefix ?? process.env.KERNEL_SEARCH_PREFIX ?? 'rezics-';
  if (!isAdmittedSearchPrefix(prefix))
    return { state: 'pending', gap: 'agent-identity-recovery-search-prefix-unavailable' };

  const homes = [...new Set([home, 0])].sort((a, b) => a - b);
  const owners = (
    await tx.query<{ partition_no: number; write_state: string }>(
      `SELECT partition_no,write_state FROM core.partition
       WHERE partition_no=ANY($1::integer[]) ORDER BY partition_no${lock ? ' FOR SHARE' : ''}`,
      [homes],
    )
  ).rows;
  const currentOwners = new Map(owners.map((owner) => [owner.partition_no, owner.write_state]));
  if (homes.some((partition) => currentOwners.get(partition) !== 'active'))
    return { state: 'pending', gap: 'agent-identity-recovery-search-home-unavailable' };

  const account = (
    await tx.query<{ state: string; authn_fenced: boolean; revision: string }>(
      `SELECT state,authn_fenced,discovery_revision::text AS revision FROM access.account
       WHERE route=$1 AND account_id=$2${lock ? ' FOR SHARE' : ''}`,
      [route, input.accountId],
    )
  ).rows[0];
  if (!account || account.state !== 'active' || account.authn_fenced)
    return { state: 'pending', gap: 'agent-identity-recovery-account-current-unavailable' };

  const generations = (
    await tx.query<{
      prefix: string;
      generation: string;
      index_uuid: string | null;
      incarnation: string;
      state: string;
    }>(
      `SELECT prefix,generation::text,index_uuid,incarnation::text,state FROM search.discovery_generation
       WHERE partition_no=0 AND prefix=$1 AND state='active'
       ORDER BY generation LIMIT $2${lock ? ' FOR SHARE' : ''}`,
      [prefix, MAX_SUBJECT_GENERATIONS + 1],
    )
  ).rows;
  if (generations.length === 0)
    return { state: 'pending', gap: 'agent-identity-recovery-search-enrollment-unavailable' };
  if (generations.length > MAX_SUBJECT_GENERATIONS)
    return { state: 'pending', gap: 'agent-identity-recovery-search-enrollment-unsupported' };

  const copies: SearchCopyState[] = [];
  for (const generation of generations) {
    if (!generation.index_uuid || generation.state !== 'active')
      return { state: 'pending', gap: 'agent-identity-recovery-search-enrollment-unavailable' };
    const population = (
      await tx.query<{ complete: boolean; certified: boolean }>(
        `SELECT complete,certified FROM search.discovery_population
         WHERE partition_no=$1 AND prefix=$2 AND generation=$3 AND owner='accounts'${lock ? ' FOR SHARE' : ''}`,
        [home, prefix, generation.generation],
      )
    ).rows[0];
    if (!population?.complete || !population.certified)
      return { state: 'pending', gap: 'agent-identity-recovery-search-population-unavailable' };

    const copy = (
      await tx.query<{ position: string; revision: string; deleted: boolean; settled: boolean }>(
        `SELECT position::text,revision::text,deleted,settled FROM search.discovery_copy
         WHERE route=$1 AND source_id=$2 AND prefix=$3 AND generation=$4 AND kind='account'${lock ? ' FOR SHARE' : ''}`,
        [route, input.accountId, prefix, generation.generation],
      )
    ).rows[0];
    if (!copy || copy.deleted || !copy.settled)
      return { state: 'pending', gap: 'agent-identity-recovery-search-copy-pending' };
    if (BigInt(copy.position) < input.eventPosition || BigInt(copy.revision) < BigInt(account.revision))
      return { state: 'pending', gap: 'agent-identity-recovery-search-copy-pending' };
    copies.push({
      generation: generation.generation,
      indexUuid: generation.index_uuid,
      incarnation: generation.incarnation,
      populationComplete: population.complete,
      populationCertified: population.certified,
      position: copy.position,
      revision: copy.revision,
      deleted: copy.deleted,
      settled: copy.settled,
    });
  }

  return {
    state: 'observed',
    digest: digest({ route, accountId: input.accountId, home, prefix, revision: account.revision, copies }),
  };
}
