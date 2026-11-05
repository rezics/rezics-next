/** Native first owner write. Logical descriptors never initialize grants or certify Source completion. */
import type { Pool, PoolClient } from 'pg';
import { readAccount } from '../access/account-data.ts';
import { shareAccount } from '../access/account-share.ts';
import { deriveAccess } from '../access/derived-access.ts';
import { parentCreationAuthorization } from '../access/parent-creation.ts';
import { initializeResourceGrants } from '../access/resource-initialization.ts';
import { installResourceRoleCatalogue, resourceRoleCatalogue } from '../access/resource-roles.ts';
import {
  authoritativeTimeValue,
  currentCommand,
  type CommandAuthorization,
  type CommandTransaction,
} from '../command/command.ts';
import { ProblemError } from '../http/problem.ts';
import type { Access, AccountActor } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import { activeRelease } from '../semantic/definitions.ts';
import { builtinCollectionId, type BuiltinCollectionKey } from './builtin-identity.ts';
import { createBuiltinRuntime } from './builtin-runtime.ts';
import { readBuiltinStateReference } from './builtin-reference-store.ts';
import type { SavedCollectionRule } from './collection-rules.ts';
import { enterShelfWrite } from './shelf-counter-owner.ts';
import { createShelfCounters } from './shelf-counters.ts';

type Client = Pick<PoolClient, 'query'>;
type Key = Exclude<BuiltinCollectionKey, { kind: 'liked' }>;
export type BuiltinPublicationRule = Readonly<{ key: Key; rule: SavedCollectionRule }>;
export type BuiltinMaterialization = Readonly<{
  key: Key;
  rule: SavedCollectionRule;
  authorization: CommandAuthorization;
  materialize(tx: CommandTransaction): Promise<void>;
}>;
const unavailable = () => new ProblemError('dependency_unavailable');
function filter(key: Key) {
  return key.kind === 'everything'
    ? { owner: { presence: true as const } }
    : {
        owner: { state: { profileId: key.profileId, stateSetId: key.stateSetId, in: [key.stateId] } },
      };
}
/** One native header, retaining accepted meaning rather than choosing a new current release. Data only. */
export async function readBuiltinPublicationRule(
  client: Client,
  route: number,
  collectionId: string,
): Promise<BuiltinPublicationRule | null> {
  const row = (
    await client.query<{
      owner: string;
      kind: Key['kind'];
      releaseDigest: string | null;
      profileId: string | null;
      stateSetId: string | null;
      stateId: string | null;
      revision: number;
      sourceGeneration: string;
    }>(
      `SELECT curator_account_id::text AS owner,builtin_kind AS kind,builtin_release_digest AS "releaseDigest",
    builtin_profile_id AS "profileId",builtin_state_set_id AS "stateSetId",builtin_state_id AS "stateId",
    revision,source_generation::text AS "sourceGeneration"
    FROM library.collection WHERE route=$1 AND collection_id=$2 AND state='active' AND membership_kind='dynamic'
      AND builtin_kind IS NOT NULL AND curator_account_id IS NOT NULL`,
      [route, collectionId],
    )
  ).rows[0];
  if (!row || !row.releaseDigest) return null;
  const key: Key | null =
    row.kind === 'everything'
      ? { kind: 'everything' }
      : row.profileId && row.stateSetId && row.stateId
        ? { kind: 'state', profileId: row.profileId, stateSetId: row.stateSetId, stateId: row.stateId }
        : null;
  if (!key || builtinCollectionId(row.owner, key) !== collectionId || routeOf(row.owner) !== route) return null;
  return {
    key,
    rule: {
      filter: filter(key),
      sort: 'id',
      source: { kind: 'owner' },
      releaseDigest: row.releaseDigest,
      revision: 0,
      collectionRevision: row.revision,
      sourceGeneration: row.sourceGeneration,
    },
  };
}

async function stateSupported(
  client: Client,
  route: number,
  accountId: string,
  collectionId: string,
  key: Extract<Key, { kind: 'state' }>,
  releaseDigest: string,
): Promise<boolean> {
  const reference = await readBuiltinStateReference(client, { route, collectionId });
  if (!reference || reference.accountId !== accountId || JSON.stringify(reference.key) !== JSON.stringify(key))
    return false;
  return (
    (
      await client.query(
        `SELECT 1 FROM library.owner_index_state s JOIN library.owner_index_control c USING(route,account_id)
    WHERE s.route=$1 AND s.account_id=$2 AND s.collection_id=$3 AND s.pin->>'releaseDigest'=$4 AND c.phase='ready'
      AND NOT EXISTS(SELECT 1 FROM library.owner_index_pin p WHERE p.route=s.route AND p.account_id=s.account_id AND NOT p.meaning_ready)
    LIMIT 1`,
        [route, accountId, collectionId, releaseDigest],
      )
    ).rows.length === 1
  );
}

/** Select only a real logical native owner descriptor. No caller tuple hints or historical release walk. */
export async function prepareBuiltinMaterialization(
  config: Readonly<{ pool: Pool; access: Access }>,
  actor: AccountActor,
  input: Readonly<{ collectionId: string; revision: number }>,
  deadline: number,
): Promise<BuiltinMaterialization | null> {
  const route = routeOf(actor.accountId)!;
  if (input.collectionId === builtinCollectionId(actor.accountId, { kind: 'liked' }))
    throw new ProblemError('unsupported_query');
  const existing = await config.pool.query('SELECT 1 FROM library.collection WHERE route=$1 AND collection_id=$2', [
    route,
    input.collectionId,
  ]);
  if (existing.rows.length) return null;
  let key: Key;
  if (input.collectionId === builtinCollectionId(actor.accountId, { kind: 'everything' })) key = { kind: 'everything' };
  else {
    const reference = await readBuiltinStateReference(config.pool, { route, collectionId: input.collectionId });
    if (!reference || reference.accountId !== actor.accountId) return null;
    key = reference.key;
  }
  const logical = await createBuiltinRuntime({ pool: config.pool }).read(
    actor,
    input.collectionId,
    'collection:update',
    deadline,
  );
  if (!logical || logical.revision !== 0 || input.revision !== 0) throw new ProblemError('conflict');
  // Everything has no profile tuple. Pin its compiler release on the first actual write, just as state meaning is pinned.
  const releaseDigest =
    key.kind === 'everything'
      ? (await activeRelease(config.pool))?.digest
      : (
          await config.pool.query<{ digest: string }>(
            `SELECT pin->>'releaseDigest' AS digest FROM library.owner_index_state
      WHERE route=$1 AND account_id=$2 AND collection_id=$3 ORDER BY pin->>'releaseDigest',pin LIMIT 1`,
            [route, actor.accountId, input.collectionId],
          )
        ).rows[0]?.digest;
  if (!releaseDigest) throw unavailable();
  const rule: SavedCollectionRule = {
    filter: filter(key),
    sort: 'id',
    source: { kind: 'owner' },
    releaseDigest,
    revision: 0,
    collectionRevision: 0,
    sourceGeneration: '0',
  };
  let inserted: { transactionId: string; at: string } | null = null;
  const resource = { route, id: input.collectionId };
  const materializationAccess = deriveAccess(config.access, {
    async authorize(client, viewer, action, parent, evidence, time) {
      if (viewer !== actor || action !== 'collection:update' || parent.route !== route || parent.id !== actor.accountId)
        return config.access.authorize(client, viewer, action, parent, evidence, time);
      if (!time || !actor.scopes.includes(action)) return false;
      authoritativeTimeValue(time);
      const account = await readAccount(client, route, actor.accountId);
      return (
        !!account &&
        account.kind === 'actor' &&
        account.state === 'active' &&
        !account.fenced &&
        account.minimumAuthnEpoch <= BigInt(actor.authnEpoch)
      );
    },
  });
  const catalogue = resourceRoleCatalogue(config.access);
  if (catalogue) installResourceRoleCatalogue(materializationAccess, catalogue);
  const authorization = parentCreationAuthorization({
    access: materializationAccess,
    actor,
    action: 'collection:update',
    parent: {
      resource: { route, id: actor.accountId },
      async validate(client, time) {
        authoritativeTimeValue(time);
        const account = await readAccount(client, route, actor.accountId);
        if (!account || account.kind !== 'actor' || account.state !== 'active' || account.fenced) return false;
        if (
          (
            await client.query('SELECT 1 FROM library.collection WHERE route=$1 AND collection_id=$2', [
              route,
              input.collectionId,
            ])
          ).rows.length
        )
          return false;
        if (
          key.kind === 'state' &&
          !(await stateSupported(client, route, actor.accountId, input.collectionId, key, releaseDigest))
        )
          return false;
        return true;
      },
    },
    context: {
      pool: config.pool,
      deadline,
      resource,
      creation: {
        async validate(tx, target, time) {
          if (!inserted || target.route !== route || target.id !== input.collectionId) return false;
          authoritativeTimeValue(time);
          return (
            (
              await tx.query(
                `SELECT 1 FROM library.collection WHERE route=$1 AND collection_id=$2 AND curator_account_id=$3
        AND revision=1 AND state='active' AND transaction_id=$4 AND created_at=$5::timestamptz AND xmin::text::bigint=pg_current_xact_id()::text::bigint % 4294967296`,
                [route, input.collectionId, actor.accountId, inserted.transactionId, inserted.at],
              )
            ).rows.length === 1
          );
        },
      },
    },
  });
  return {
    key,
    rule,
    authorization,
    async materialize(tx) {
      inserted = null;
      const command = currentCommand(tx);
      await shareAccount(tx, actor.accountId);
      // The original command holds the actual fact head through commit; recheck support under that fence.
      if (
        key.kind === 'state' &&
        !(await stateSupported(tx, route, actor.accountId, input.collectionId, key, releaseDigest))
      )
        throw unavailable();
      await enterShelfWrite({ client: tx, route, accountId: actor.accountId });
      const at = authoritativeTimeValue(command.time);
      await tx.query(
        `INSERT INTO library.collection(route,collection_id,curator_account_id,title,visibility,membership_kind,
      builtin_kind,builtin_release_digest,builtin_profile_id,builtin_state_set_id,builtin_state_id,created_at,updated_at,transaction_id,state,revision)
      VALUES($1,$2,$3,$11,'private','dynamic',$4,$5,$6,$7,$8,$9::timestamptz,$9::timestamptz,$10,'active',1)`,
        [
          route,
          input.collectionId,
          actor.accountId,
          key.kind,
          releaseDigest,
          key.kind === 'state' ? key.profileId : null,
          key.kind === 'state' ? key.stateSetId : null,
          key.kind === 'state' ? key.stateId : null,
          at,
          command.transactionId,
          key.kind === 'everything' ? 'Everything' : key.stateId,
        ],
      );
      inserted = { transactionId: command.transactionId, at };
      await initializeResourceGrants(tx, { resource, type: 'library.collection', creator: actor.accountId });
      await createShelfCounters().collection({ client: tx, route, accountId: actor.accountId }, 1);
    },
  };
}
