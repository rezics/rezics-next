import type { Pool, PoolClient } from 'pg';
import type { OperationalTransaction } from '../command/operational.ts';
import { hasLiveOperationalTransaction } from '../command/operational.ts';
import { routeOf } from '../route/route.ts';
import { readRelease } from '../semantic/definitions.ts';
import { builtinCollectionId } from './builtin-identity.ts';
import { decodeLibraryProfilePin } from './profile-pin.ts';
import { resolveLibraryProfilePin } from './profile.ts';
import { ProblemError } from '../http/problem.ts';

type Client = Pick<PoolClient, 'query'>;
export type OwnerPinMeaning = Readonly<{
  pin: unknown;
  states: readonly {
    collectionId: string;
    profileId: string;
    stateSetId: string;
    stateId: string;
    labels: Readonly<Record<string, string>>;
  }[];
}>;
/** Release this owner's connection BEFORE loading its immutable Definitions release. No current-head inference. */
export async function nextOwnerPin(client: Client, accountId: string): Promise<unknown | undefined> {
  const { rows } = await client.query<{ pin: unknown }>(
    `SELECT pin FROM library.owner_index_pin
    WHERE route=$1 AND account_id=$2 AND NOT meaning_ready ORDER BY pin LIMIT 1`,
    [routeOf(accountId), accountId],
  );
  return rows[0]?.pin;
}
export async function loadOwnerPinMeaning(pool: Pool, accountId: string, value: unknown): Promise<OwnerPinMeaning> {
  // Empty is the structural label/unpinned scope, not a fabricated accepted profile.
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === 0)
    return { pin: value, states: [] };
  const pin = decodeLibraryProfilePin(value);
  if (!pin) throw new ProblemError('semantic_not_ready');
  const release = await readRelease(pool, pin.releaseDigest, { composed: false });
  if (!release) throw new ProblemError('semantic_not_ready');
  const profile = resolveLibraryProfilePin({ digest: pin.releaseDigest, release }, pin);
  if (!profile) throw new ProblemError('semantic_not_ready');
  const set = profile.entryStateSet;
  if (!set) return { pin: value, states: [] };
  if (set.states.length > 64) throw new Error('Released Library state-set exceeds its bound');
  return {
    pin: value,
    states: set.states.map((state) => ({
      collectionId: builtinCollectionId(accountId, {
        kind: 'state',
        profileId: pin.profileId,
        stateSetId: set.id,
        stateId: state.id,
      }),
      profileId: pin.profileId,
      stateSetId: set.id,
      stateId: state.id,
      labels: state.labels ?? {},
    })),
  };
}

/** Same source-head fence as every native family writer. Stale work cannot resurrect a removed pin. */
export async function applyOwnerPinMeaning(tx: OperationalTransaction, accountId: string, meaning: OwnerPinMeaning) {
  if (!hasLiveOperationalTransaction(tx)) throw new TypeError('Pin metadata needs a live operational transaction');
  const key = [routeOf(accountId), accountId];
  await tx.query('SELECT 1 FROM library.fact_source_head WHERE route=$1 AND account_id=$2 FOR UPDATE', key);
  const found = await tx.query(
    `SELECT 1 FROM library.owner_index_pin
    WHERE route=$1 AND account_id=$2 AND pin=$3::jsonb AND NOT meaning_ready FOR UPDATE`,
    [...key, JSON.stringify(meaning.pin)],
  );
  if (!found.rows.length) return;
  for (const state of meaning.states) {
    const reference = await tx.query(
      `INSERT INTO library.builtin_collection_reference AS current
      (route,account_id,collection_id,profile_id,state_set_id,state_id) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(route,collection_id) DO UPDATE SET collection_id=EXCLUDED.collection_id
      WHERE (current.account_id,current.profile_id,current.state_set_id,current.state_id)=
        (EXCLUDED.account_id,EXCLUDED.profile_id,EXCLUDED.state_set_id,EXCLUDED.state_id)
      RETURNING collection_id`,
      [...key, state.collectionId, state.profileId, state.stateSetId, state.stateId],
    );
    if (reference.rows.length !== 1) throw new Error('Builtin state reference collision');
    await tx.query(
      `INSERT INTO library.owner_index_state(route,account_id,pin,collection_id,labels)
      VALUES($1,$2,$3::jsonb,$4,$5::jsonb) ON CONFLICT DO NOTHING`,
      [...key, JSON.stringify(meaning.pin), state.collectionId, JSON.stringify(state.labels)],
    );
  }
  await tx.query(
    `UPDATE library.owner_index_pin SET meaning_ready=true
    WHERE route=$1 AND account_id=$2 AND pin=$3::jsonb`,
    [...key, JSON.stringify(meaning.pin)],
  );
}
