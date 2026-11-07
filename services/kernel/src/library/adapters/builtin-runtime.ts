import { readLikedOriginalPage, readLikedOriginalVersion } from '../liked-source.ts';
import { readOwnerMembers } from '../owner-index-members.ts';
import type { KeyRing } from '../../tokens/seal.ts';
import { nextOwnerPin } from '../owner-index-metadata.ts';
import type { Pool, PoolClient } from 'pg';
import { createBuiltinOwnerAdmission, createBuiltinMembersApplication } from '../application/index.ts';
import type { NativeLibraryPresentationPorts } from './presentation.ts';
import { deadlineClient } from '../../access/authenticate.ts';
import { withConnection } from '../../database/pool.ts';
import { ProblemError } from '../../http/problem.ts';
import type { Access, Actor, AccountActor } from '../../request/access.ts';
import { deadlineFor } from '../../request/deadline.ts';
import { routeOf } from '../../route/route.ts';
import { builtinCollectionId, type BuiltinCollectionKey } from '../builtin-identity.ts';
import { readBuiltinStateReference } from '../builtin-reference-store.ts';
import { readOwnerIndexFrontier, readOwnerOriginalPrefix, readOwnerOriginalTruth } from '../owner-index.ts';
import { WORK_STEP_DEADLINE_MS } from '../command-support.ts';
import type { CollectionKind } from '../collection-kind.ts';
import type { OwnerQueryDependencies } from '../builtin-runtime-query.ts';
import type { FilterDocument } from '@rezics/filter';

export type BuiltinCollectionView = {
  id: string;
  curatorAccountId: string;
  membershipKind: 'dynamic';
  builtinKind: 'everything' | 'state' | 'liked';
  builtin: BuiltinCollectionKey;
  builtinLabels?: Readonly<Record<string, string>>;
  visibility: 'private';
  title: string | null;
  description: string | null;
  revision: number;
  presentationKind: CollectionKind['presentationKind'];
  presentationKindSource: CollectionKind['presentationKindSource'];
  cover: null;
  coverSource: 'none';
};
export type DynamicMemberView = { kind: 'dynamic'; subjectId: string };

function descriptor(accountId: string, key: BuiltinCollectionKey): BuiltinCollectionView {
  return {
    id: builtinCollectionId(accountId, key),
    curatorAccountId: accountId,
    membershipKind: 'dynamic',
    builtinKind: key.kind,
    builtin: key,
    visibility: 'private',
    title: null,
    description: null,
    revision: 0,
    presentationKind: null,
    presentationKindSource: 'mixed',
    cover: null,
    coverSource: 'none',
  };
}
type Client = Pick<PoolClient, 'query'>;
type ReadScope = 'collection:read' | 'collection:update' | 'collection:delete';
async function nativePresence(client: Client, actor: AccountActor) {
  const { rows } = await client.query<{
    entry: boolean;
    session: boolean;
    copy: boolean;
    label: boolean;
  }>(
    `SELECT
    EXISTS(SELECT 1 FROM library.entry WHERE route=$1 AND account_id=$2) AS entry,
    EXISTS(SELECT 1 FROM library.progress_session WHERE route=$1 AND account_id=$2 AND state <> 'retired') AS session,
    EXISTS(SELECT 1 FROM library.copy WHERE route=$1 AND account_id=$2 AND deletion_id IS NULL) AS copy,
    EXISTS(SELECT 1 FROM library.label_assignment WHERE route=$1 AND account_id=$2 AND deleted_at IS NULL) AS label`,
    [routeOf(actor.accountId), actor.accountId],
  );
  return rows[0]!;
}

/** Logical owner reads share the native account/scopes boundary. They create no header, grant, receipt or work. */
export function createNativeBuiltinRuntime(
  ports: NativeLibraryPresentationPorts,
  config: Omit<OwnerQueryDependencies, 'access'> & {
    access?: Access;
    tokens?: KeyRing;
  },
) {
  const admitted = createBuiltinOwnerAdmission(ports.accountEligibility);
  async function snapshot<T>(operation: (client: Client) => Promise<T>, deadline = deadlineFor(WORK_STEP_DEADLINE_MS)) {
    return withConnection(config.pool, async (connection) => {
      const client = deadlineClient(connection, deadline);
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        const result = await operation(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  }
  async function read(
    actor: Actor,
    id: string,
    scope: ReadScope = 'collection:read',
    deadline = deadlineFor(WORK_STEP_DEADLINE_MS),
  ): Promise<BuiltinCollectionView | null> {
    if (routeOf(id) === null) return null;
    return snapshot(async (client) => {
      const owner = await admitted(client, actor, scope);
      if (!owner) return null;
      const ownEverything = builtinCollectionId(owner.accountId, {
        kind: 'everything',
      });
      let key: BuiltinCollectionKey;
      if (id === ownEverything) key = { kind: 'everything' };
      else if (id === builtinCollectionId(owner.accountId, { kind: 'liked' })) key = { kind: 'liked' };
      else {
        // Exactly the delivered native reference point, with no tuple hint or historical-release walk.
        const reference = await readBuiltinStateReference(client, {
          route: routeOf(id)!,
          collectionId: id,
        });
        if (!reference || reference.accountId !== owner.accountId) return null;
        const coverage = await readOwnerIndexFrontier(client, owner.accountId);
        if (coverage?.phase !== 'ready' || (await nextOwnerPin(client, owner.accountId)) !== undefined)
          throw new ProblemError('dependency_unavailable');
        const supported = await client.query(
          `SELECT 1 FROM library.owner_index_state s
          WHERE s.route=$1 AND s.account_id=$2 AND s.collection_id=$3 LIMIT 1`,
          [routeOf(owner.accountId), owner.accountId, id],
        );
        if (!supported.rows.length) return null;
        key = reference.key;
      }
      return present(client, owner.accountId, key);
    }, deadline);
  }
  async function present(client: Client, accountId: string, key: BuiltinCollectionKey): Promise<BuiltinCollectionView> {
    const value = descriptor(accountId, key);
    let labels: Readonly<Record<string, string>> | undefined;
    if (key.kind === 'state') {
      // The index chooses presentation only, never state membership or disclosure.
      const meaning = await client.query<{ labels: Record<string, string> }>(
        `SELECT labels FROM library.owner_index_state WHERE route=$1 AND account_id=$2 AND collection_id=$3
         ORDER BY pin->>'releaseDigest',pin LIMIT 1`,
        [routeOf(accountId), accountId, value.id],
      );
      if (!meaning.rows[0]) throw new ProblemError('semantic_not_ready');
      labels = meaning.rows[0].labels;
    }
    const stored = (
      await client.query<{
        kind: string | null;
        owner: string | null;
        membership: string;
        state: string;
        visibility: string;
        title: string;
        description: string | null;
        revision: number;
        presentationKind: string | null;
        coverMediaId: string | null;
      }>(
        `SELECT builtin_kind AS kind,curator_account_id AS owner,membership_kind AS membership,state,visibility,
        title,description,revision,presentation_kind AS "presentationKind",cover_media_id AS "coverMediaId"
       FROM library.collection WHERE route=$1 AND collection_id=$2`,
        [routeOf(value.id), value.id],
      )
    ).rows[0];
    if (stored) {
      if (stored.owner !== accountId || stored.kind !== key.kind || stored.membership !== 'dynamic')
        throw new ProblemError('dependency_unavailable');
      if (stored.state !== 'active') throw new ProblemError('not_found');
      // Published output and configured covers use their owning current readers, never a private fallback.
      if (stored.visibility !== 'private' || stored.presentationKind !== null || stored.coverMediaId !== null)
        throw new ProblemError('dependency_unavailable', {
          detail: 'The configured built-in presentation reader is unavailable.',
        });
      return {
        ...value,
        title: stored.title,
        description: stored.description,
        revision: stored.revision,
        ...(labels === undefined ? {} : { builtinLabels: labels }),
      };
    }
    return {
      ...value,
      ...(labels === undefined ? {} : { builtinLabels: labels }),
    };
  }
  async function discover(actor: Actor, after: string | null = null, limit = 100): Promise<BuiltinCollectionView[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 101)
      throw new RangeError('Builtin descriptor limit must be 1..101');
    return snapshot(async (client) => {
      const owner = await admitted(client, actor);
      if (!owner) return [];
      const presence = await nativePresence(client, owner);
      if (presence.entry || presence.session || presence.copy) {
        const coverage = await readOwnerIndexFrontier(client, owner.accountId);
        if (coverage?.phase !== 'ready' || (await nextOwnerPin(client, owner.accountId)) !== undefined)
          throw new ProblemError('semantic_not_ready');
      }
      // Always logical, even when no profile or native personal fact exists.
      const keys: BuiltinCollectionKey[] = [{ kind: 'everything' }, { kind: 'liked' }];
      // One indexed successor per descriptor skips all same-identity pins, including old release fanout.
      const states = await client.query<{
        profileId: string;
        stateSetId: string;
        stateId: string;
      }>(
        `WITH RECURSIVE keys(collection_id,n) AS (
          (SELECT collection_id,1 FROM library.owner_index_state
            WHERE route=$1 AND account_id=$2 AND ($3::uuid IS NULL OR collection_id>$3)
            ORDER BY collection_id LIMIT 1)
          UNION ALL
          SELECT next.collection_id,k.n+1 FROM keys k CROSS JOIN LATERAL (
            SELECT collection_id FROM library.owner_index_state
            WHERE route=$1 AND account_id=$2 AND collection_id>k.collection_id
            ORDER BY collection_id LIMIT 1
          ) next WHERE k.n<$4
        )
        SELECT r.profile_id AS "profileId",r.state_set_id AS "stateSetId",r.state_id AS "stateId"
        FROM keys k JOIN library.builtin_collection_reference r
          ON r.route=$1 AND r.collection_id=k.collection_id AND r.account_id=$2
        ORDER BY k.collection_id`,
        [routeOf(owner.accountId), owner.accountId, after, limit],
      );
      keys.push(...states.rows.map((state) => ({ kind: 'state' as const, ...state })));
      const selected = keys
        .map((key) => ({ key, id: builtinCollectionId(owner.accountId, key) }))
        .filter((value) => after === null || value.id > after)
        .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
        .slice(0, limit);
      const values: BuiltinCollectionView[] = [];
      for (const value of selected) values.push(await present(client, owner.accountId, value.key));
      return values;
    });
  }
  const members = createBuiltinMembersApplication<
    BuiltinCollectionView,
    { filter: FilterDocument; releaseDigest: string },
    DynamicMemberView
  >({
    read: (actor, id, deadline) => read(actor, id, 'collection:read', deadline),
    async proveEmpty(actor, source, deadline) {
      return snapshot(async (client) => {
        const owner = await admitted(client, actor);
        if (!owner) throw new ProblemError('not_found');
        if (source.builtinKind === 'liked') {
          const page = await readLikedOriginalPage(client, {
            actorAccountId: owner.accountId,
            limit: 1,
          });
          return page.subjects.length === 0 && page.next === null;
        }
        if (source.builtinKind !== 'everything') return false;
        const presence = await nativePresence(client, owner);
        return !Object.values(presence).some(Boolean);
      }, deadline);
    },
    async readPage(actor, collectionId, options) {
      if (actor.kind !== 'account') throw new ProblemError('not_found');
      const { access, tokens } = config;
      if (!access || !tokens)
        throw new ProblemError('dependency_unavailable', {
          detail: 'Built-in members require current Access and cursor keys.',
        });
      return readOwnerMembers(
        { ...config, access, tokens },
        {
          actor,
          collectionId,
          limit: options.limit,
          deadline: options.deadline,
          ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
          ...(options.query ? { query: options.query } : {}),
          revalidateOwner: options.revalidateOwner,
          readSourceVersion: options.readSourceVersion,
        },
      );
    },
    sourceVersion,
    deadline: () => deadlineFor(WORK_STEP_DEADLINE_MS),
    invalidRequest: () => new ProblemError('invalid_request'),
    notFound: () => new ProblemError('not_found'),
  });
  async function sourceVersion(actor: Actor, source: BuiltinCollectionView, deadline: number, allowAbsent = false) {
    return snapshot(async (client) => {
      const owner = await admitted(client, actor);
      if (!owner) throw new ProblemError('not_found');
      if (source.builtinKind === 'liked') return readLikedOriginalVersion(client, owner.accountId);
      const head = (
        await client.query<{ generation: string }>(
          'SELECT generation::text AS generation FROM library.fact_source_head WHERE route=$1 AND account_id=$2',
          [routeOf(owner.accountId), owner.accountId],
        )
      ).rows[0];
      if (!head && !allowAbsent) throw new ProblemError('semantic_not_ready');
      return head?.generation ?? 'absent';
    }, deadline);
  }
  async function resolve(actor: Actor, key: Exclude<BuiltinCollectionKey, { kind: 'liked' }>, deadline?: number) {
    if (actor.kind !== 'account') return null;
    return read(actor, builtinCollectionId(actor.accountId, key), 'collection:read', deadline);
  }
  return { read, discover, resolve, members, sourceVersion };
}

/** Internal native primitive for the real participant/retained plan integration. Never a successful member page. */
export async function readNativeBuiltinOriginalInputs(
  ports: NativeLibraryPresentationPorts,
  pool: Pool,
  accountId: string,
  after: string | null,
  limit: number,
) {
  const facts = await withConnection(pool, async (client) => {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      const originals = await readOwnerOriginalPrefix(client, accountId, after, limit);
      const truth = [];
      for (const original of originals) truth.push(await readOwnerOriginalTruth(client, accountId, original));
      await client.query('COMMIT');
      return truth;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
  // Actual declared batched API, after releasing the owner home. No self/default-zero mapping fallback.
  const mapping = await ports.readMappings(
    pool,
    facts.map((fact) => fact.original),
  );
  return facts.map((fact, index) => ({ fact, mapping: mapping[index]! }));
}
