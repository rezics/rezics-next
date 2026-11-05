import type { PoolClient } from 'pg';
import { routeOf } from '../route/route.ts';
import { builtinCollectionId, type BuiltinCollectionKey } from './builtin-identity.ts';
import read from './builtin-reference-read.sql';
import bind from './builtin-reference-bind.sql';
import unbind from './builtin-reference-unbind.sql';

type Client = Pick<PoolClient, 'query'>;
export type BuiltinStateReference = Readonly<{
  route: number;
  collectionId: string;
  accountId: string;
  key: Extract<BuiltinCollectionKey, { kind: 'state' }>;
}>;
type Witness = Readonly<{
  accountId: string;
  subjectId: string;
  sourceRevision: number;
  sourceTransactionId: string;
}>;
type BindInput = Witness &
  Readonly<{
    releaseDigest: string;
    profileId: string;
    stateSetId: string;
    stateId: string;
  }>;
type Row = NonNullable<Awaited<ReturnType<typeof read.run>>>;

function reference(row: Row): BuiltinStateReference {
  return {
    route: row.route,
    collectionId: row.collectionId,
    accountId: row.accountId,
    key: { kind: 'state', profileId: row.profileId, stateSetId: row.stateSetId, stateId: row.stateId },
  };
}

/** One private keyed probe. The logical adapter must authorize the owner, then verify current in-use evidence. */
export async function readBuiltinStateReference(
  client: Client,
  input: Readonly<{ route: number; collectionId: string }>,
): Promise<BuiltinStateReference | null> {
  const row = await read.run(
    { query: client.query.bind(client) },
    {
      route: input.route,
      collection_id: input.collectionId,
    },
  );
  return row ? reference(row) : null;
}

/**
 * Caller owns the command authorization, native shareAccount/fact fence and accepted immutable release validation
 * (including state-set membership). Use its transaction; this DAO only verifies the exact stored entry witness/pin.
 */
export async function bindBuiltinStateReference(
  client: Client,
  input: BindInput,
): Promise<BuiltinStateReference | null> {
  const key = {
    kind: 'state',
    profileId: input.profileId,
    stateSetId: input.stateSetId,
    stateId: input.stateId,
  } as const;
  const collectionId = builtinCollectionId(input.accountId, key);
  const rows = await bind.run(
    { query: client.query.bind(client) },
    {
      route: routeOf(input.accountId)!,
      collection_id: collectionId,
      account_id: input.accountId,
      subject_id: input.subjectId,
      source_revision: input.sourceRevision,
      source_transaction_id: input.sourceTransactionId,
      release_digest: input.releaseDigest,
      profile_id: input.profileId,
      state_set_id: input.stateSetId,
      state_id: input.stateId,
    },
  );
  return rows[0] ? reference(rows[0]) : null;
}

/** Exact old witness removal only; directory cleanup and account purge are separate bounded adapter work. */
export async function unbindBuiltinStateReference(
  client: Client,
  input: Witness & Readonly<{ route: number }>,
): Promise<boolean> {
  const row = await unbind.run(
    { query: client.query.bind(client) },
    {
      route: input.route,
      account_id: input.accountId,
      subject_id: input.subjectId,
      source_revision: input.sourceRevision,
      source_transaction_id: input.sourceTransactionId,
    },
  );
  return row?.removed === true;
}
