import { nextOwnerPin } from './owner-index-metadata.ts';
import type { Pool, PoolClient } from 'pg';
import { readAccount } from '../access/account-data.ts';
import { deadlineClient } from '../access/authenticate.ts';
import { withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import type { Actor, AccountActor } from '../request/access.ts';
import { deadlineFor } from '../request/deadline.ts';
import { routeOf } from '../route/route.ts';
import { readIdentityMappings } from '../semantic/identity-epoch-read.ts';
import type { ResumeIdentityEpochJob, WaitIdentityEpochPublished } from '../semantic/identity-epoch-contract.ts';
import type { PublicFilterSourceFactory } from '../semantic/public-filter-source-contract.ts';
import { builtinCollectionId, type BuiltinCollectionKey } from './builtin-identity.ts';
import { readBuiltinStateReference } from './builtin-reference-store.ts';
import { readOwnerIndexFrontier, readOwnerOriginalPrefix, readOwnerOriginalTruth } from './owner-index.ts';
import { WORK_STEP_DEADLINE_MS } from './command-support.ts';

export type BuiltinCollectionView = {
  id: string; curatorAccountId: string; membershipKind: 'dynamic';
  builtinKind: 'everything' | 'state'; builtin: BuiltinCollectionKey;
  builtinLabels?: Readonly<Record<string,string>>;
  visibility: 'private'; title: string | null; description: string | null; revision: number;
  presentationKind: null; presentationKindSource: 'empty'; cover: null; coverSource: 'none';
};
export type DynamicMemberView = { kind: 'dynamic'; subjectId: string };

/** Exact already-published producer types. No guessed callback, publication result, epoch or privacy certificate. */
type DeferredBindings = Readonly<{
  resumeIdentityEpochJob: ResumeIdentityEpochJob | null;
  waitIdentityEpochPublished: WaitIdentityEpochPublished | null;
  publicFilterSource: PublicFilterSourceFactory | null;
}>;
const deferred: DeferredBindings = {
  resumeIdentityEpochJob: null, waitIdentityEpochPublished: null, publicFilterSource: null,
};
function requireCurrentQueryRuntime(): never {
  // The fixed ALL-Library participant must also adopt the structural directory before these bindings can go live.
  // Registration/types and a mapped point do not establish whole-source publication or excluded/order safety.
  if (!deferred.resumeIdentityEpochJob || !deferred.waitIdentityEpochPublished || !deferred.publicFilterSource)
    throw new ProblemError('dependency_unavailable');
  throw new ProblemError('dependency_unavailable');
}
function descriptor(accountId: string, key: BuiltinCollectionKey): BuiltinCollectionView {
  return { id: builtinCollectionId(accountId,key), curatorAccountId: accountId,
    membershipKind: 'dynamic', builtinKind: key.kind, builtin: key,
    visibility: 'private', title: null, description: null, revision: 0,
    presentationKind: null, presentationKindSource: 'empty', cover: null, coverSource: 'none' };
}
type Client = Pick<PoolClient,'query'>;
async function admitted(client: Client, actor: Actor): Promise<AccountActor | null> {
  if (actor.kind !== 'account' || !actor.scopes.includes('collection:read')) return null;
  const route = routeOf(actor.accountId);
  if (route === null) return null;
  const current = await readAccount(client,route,actor.accountId);
  if (!current || current.kind !== 'actor' || current.state !== 'active' || current.fenced ||
    !Number.isSafeInteger(actor.authnEpoch) || actor.authnEpoch < 1 ||
    current.minimumAuthnEpoch > BigInt(actor.authnEpoch)) return null;
  return actor;
}
async function nativePresence(client: Client, actor: AccountActor) {
  const { rows } = await client.query<{ entry: boolean; session: boolean; copy: boolean; label: boolean }>(`SELECT
    EXISTS(SELECT 1 FROM library.entry WHERE route=$1 AND account_id=$2) AS entry,
    EXISTS(SELECT 1 FROM library.progress_session WHERE route=$1 AND account_id=$2) AS session,
    EXISTS(SELECT 1 FROM library.copy WHERE route=$1 AND account_id=$2 AND deletion_id IS NULL) AS copy,
    EXISTS(SELECT 1 FROM library.label_assignment WHERE route=$1 AND account_id=$2 AND deleted_at IS NULL) AS label`,
  [routeOf(actor.accountId),actor.accountId]);
  return rows[0]!;
}

/** Logical owner reads share the native account/scopes boundary. They create no header, grant, receipt or work. */
export function createBuiltinRuntime(config: { pool: Pool }) {
  async function snapshot<T>(operation: (client: Client) => Promise<T>, deadline = deadlineFor(WORK_STEP_DEADLINE_MS)) {
    return withConnection(config.pool, async connection => {
      const client = deadlineClient(connection,deadline);
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try { const result = await operation(client); await client.query('COMMIT'); return result; }
      catch (error) { await client.query('ROLLBACK'); throw error; }
    });
  }
  async function read(actor: Actor, id: string): Promise<BuiltinCollectionView | null> {
    if (routeOf(id) === null) return null;
    return snapshot(async client => {
      const owner = await admitted(client,actor);
      if (!owner) return null;
      const ownEverything = builtinCollectionId(owner.accountId,{ kind:'everything' });
      let key: BuiltinCollectionKey;
      if (id === ownEverything) key = { kind:'everything' };
      else {
        // Exactly the delivered native reference point, with no tuple hint or historical-release walk.
        const reference = await readBuiltinStateReference(client,{ route:routeOf(id)!,collectionId:id });
        if (!reference || reference.accountId !== owner.accountId) return null;
        const coverage = await readOwnerIndexFrontier(client,owner.accountId);
        if (coverage?.phase !== 'ready' || await nextOwnerPin(client,owner.accountId) !== undefined)
          throw new ProblemError('dependency_unavailable');
        const supported = await client.query(`SELECT 1 FROM library.owner_index_state s
          WHERE s.route=$1 AND s.account_id=$2 AND s.collection_id=$3 LIMIT 1`,
        [routeOf(owner.accountId),owner.accountId,id]);
        if (!supported.rows.length) return null;
        key = reference.key;
      }
      const { rows } = await client.query<{ kind: string | null; owner: string | null; membership: string }>(
        `SELECT builtin_kind AS kind,curator_account_id AS owner,membership_kind AS membership
         FROM library.collection WHERE route=$1 AND collection_id=$2`,[routeOf(id),id]);
      const stored = rows[0];
      if (stored) {
        if (stored.owner !== owner.accountId || stored.kind !== key.kind || stored.membership !== 'dynamic')
          throw new ProblemError('dependency_unavailable');
        // Materialized accepted meaning/title must be consumed by the eventual shared current reader.
        return requireCurrentQueryRuntime();
      }
      if (key.kind === 'state') return requireCurrentQueryRuntime();
      return descriptor(owner.accountId,key);
    });
  }
  async function discover(actor: Actor, after: string | null = null): Promise<BuiltinCollectionView[]> {
    return snapshot(async client => {
      const owner = await admitted(client,actor);
      if (!owner) return [];
      const presence = await nativePresence(client,owner);
      // Labels introduce no profile lookup or sibling identities. Unknown pinned meanings never become ready zero.
      if (presence.entry || presence.session || presence.copy) return requireCurrentQueryRuntime();
      const value = descriptor(owner.accountId,{ kind:'everything' });
      return after === null || value.id > after ? [value] : [];
    });
  }
  async function members(actor: Actor, id: string, options: { limit?: number; cursor?: string | null } = {}):
    Promise<{ members: DynamicMemberView[]; next: string | null }> {
    if (!Number.isInteger(options.limit ?? 20) || (options.limit ?? 20)<1 || (options.limit ?? 20)>100)
      throw new ProblemError('invalid_request');
    const source = await read(actor,id);
    if (!source) throw new ProblemError('not_found');
    // A structural directory miss is never an empty proof. Only independent complete native EXISTS can prove empty.
    return snapshot(async client => {
      const owner = await admitted(client,actor);
      if (!owner) throw new ProblemError('not_found');
      const presence = await nativePresence(client,owner);
      if (source.builtinKind !== 'everything' || Object.values(presence).some(Boolean)) return requireCurrentQueryRuntime();
      // There is no published source/identity cursor basis to validate yet; never accept a foreign/forged cursor.
      if (options.cursor != null) throw new ProblemError('invalid_cursor');
      return { members: [], next: null };
    });
  }
  return { read, discover, members };
}

/** Internal native primitive for the real participant/retained plan integration. Never a successful member page. */
export async function readBuiltinOriginalInputs(pool: Pool, accountId: string, after: string | null, limit: number) {
  const facts = await withConnection(pool, async client => {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      const originals = await readOwnerOriginalPrefix(client,accountId,after,limit);
      const truth = [];
      for (const original of originals) truth.push(await readOwnerOriginalTruth(client,accountId,original));
      await client.query('COMMIT');
      return truth;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
  });
  // Actual declared batched API, after releasing the owner home. No self/default-zero mapping fallback.
  const mapping = await readIdentityMappings(pool,facts.map(fact => fact.original));
  return facts.map((fact,index) => ({ fact,mapping:mapping[index]! }));
}
