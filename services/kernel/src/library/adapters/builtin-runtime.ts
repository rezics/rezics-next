import { readLikedOriginalPage, readLikedOriginalVersion } from '../liked-source.ts';
import { readLogicalEverythingMembers } from '../logical-everything-members.ts';
import type { CollectionMemberAdmission } from '../owner-filter.ts';
import { readOwnerMembers } from '../owner-index-members.ts';
import type { KeyRing } from '../../tokens/seal.ts';
import { nextOwnerPin } from '../owner-index-metadata.ts';
import type { Pool, PoolClient } from 'pg';
import { createBuiltinOwnerAdmission, createBuiltinMembersApplication } from '../application/index.ts';
import type { NativeLibraryPresentationPorts } from './presentation.ts';
import { AccessUnavailableError, classifyUnavailability, throwAccessUnavailable } from '../../access/unavailable.ts';
import { withBoundedReadOnlyTransaction, withConnection } from '../../database/pool.ts';
import { ProblemError } from '../../http/problem-error.ts';
import type { Access, Actor, AccountActor } from '../../request/access.ts';
import { deadlineFor } from '../../request/deadline.ts';
import { routeOf } from '../../route/route.ts';
import { builtinCollectionId, type BuiltinCollectionKey } from '../builtin-identity.ts';
import { readBuiltinStateReference } from '../builtin-reference-store.ts';
import {
  isOwnerEverythingEmpty,
  readOwnerFactPresence,
  readOwnerIndexFrontier,
  readOwnerOriginalPrefix,
  readOwnerOriginalTruth,
} from '../owner-index.ts';
import { WORK_STEP_DEADLINE_MS } from '../work-step-deadline.ts';
import type { CollectionKind } from '../collection-kind.ts';
import { ownerQueryWork, type OwnerQueryDependencies } from '../builtin-runtime-query.ts';
import type { FilterDocument } from '@rezics/filter';
import { consumeFollowWork } from '../follow-operation-bounds.ts';
import { semanticObservationBound } from '../semantic-observation.ts';

export type BuiltinCollectionView = {
  id: string;
  curatorAccountId: string;
  membershipKind: 'dynamic';
  builtinKind: 'everything' | 'state' | 'liked';
  builtin: BuiltinCollectionKey;
  builtinLabels?: Readonly<Record<string, string>>;
  visibility: 'private' | 'public' | 'unlisted';
  title: string | null;
  description: string | null;
  revision: number;
  presentationKind: CollectionKind['presentationKind'];
  presentationKindSource: CollectionKind['presentationKindSource'];
  cover: null;
  coverSource: 'none' | 'pending';
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
const boundedSnapshotOptions = {
  deadlineError: () => new AccessUnavailableError('deadline'),
  mapError(error: unknown) {
    try {
      throwAccessUnavailable(error);
    } catch (mapped) {
      return mapped;
    }
    return error;
  },
  isUncertainError: (error: unknown) => classifyUnavailability(error) !== undefined,
  isUncertainSettledQueryError: () => true,
};

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
    let operationFailed = false;
    let operationFailure: unknown;
    const read = async (client: PoolClient) => {
      try {
        return await operation(client);
      } catch (error) {
        operationFailed = true;
        operationFailure = error;
        throw error;
      }
    };
    return withBoundedReadOnlyTransaction(config.pool, deadline, read, boundedSnapshotOptions).catch(
      (error: unknown) => {
        if (operationFailed) throw operationFailure;
        throw error;
      },
    );
  }
  async function read(
    actor: Actor,
    id: string,
    scope: ReadScope = 'collection:read',
    deadline = deadlineFor(WORK_STEP_DEADLINE_MS),
    forMembers = false,
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
        key = reference.key;
      }
      const stored = await storedDescriptor(client, owner.accountId, key);
      // Public materialized headers and membership go through the same Access and publication path for every reader.
      if (stored && scope === 'collection:read') {
        if (stored.visibility !== 'private') return null;
        if (!forMembers && (stored.presentationKind !== null || stored.coverMediaId !== null)) return null;
      }
      if (key.kind === 'state') {
        const coverage = await readOwnerIndexFrontier(client, owner.accountId);
        if (coverage?.phase !== 'ready' || (await nextOwnerPin(client, owner.accountId)) !== undefined)
          throw new ProblemError('dependency_unavailable');
        const supported = await client.query(
          `SELECT 1 FROM library.owner_index_state s
          WHERE s.route=$1 AND s.account_id=$2 AND s.collection_id=$3 LIMIT 1`,
          [routeOf(owner.accountId), owner.accountId, id],
        );
        if (!supported.rows.length) return null;
      }
      return present(client, owner.accountId, key, stored);
    }, deadline);
  }

  async function storedDescriptor(client: Client, accountId: string, key: BuiltinCollectionKey) {
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
        [routeOf(accountId), builtinCollectionId(accountId, key)],
      )
    ).rows[0];
    if (!stored) return null;
    if (stored.owner !== accountId || stored.kind !== key.kind || stored.membership !== 'dynamic')
      throw new ProblemError('dependency_unavailable');
    if (stored.state !== 'active') throw new ProblemError('not_found');
    const visibility = stored.visibility;
    if (
      (visibility !== 'private' && visibility !== 'public' && visibility !== 'unlisted') ||
      (key.kind === 'liked' && visibility !== 'private')
    )
      throw new ProblemError('dependency_unavailable');
    return { ...stored, visibility } satisfies Pick<BuiltinCollectionView, 'visibility'>;
  }

  async function present(
    client: Client,
    accountId: string,
    key: BuiltinCollectionKey,
    stored: Awaited<ReturnType<typeof storedDescriptor>>,
  ): Promise<BuiltinCollectionView> {
    const value = descriptor(accountId, key);
    const labels =
      key.kind === 'state'
        ? (
            await client.query<{ labels: Record<string, string> }>(
              `SELECT labels FROM library.owner_index_state WHERE route=$1 AND account_id=$2 AND collection_id=$3
                ORDER BY pin->>'releaseDigest',pin LIMIT 1`,
              [routeOf(accountId), accountId, value.id],
            )
          ).rows[0]?.labels
        : undefined;
    if (key.kind === 'state' && labels === undefined) throw new ProblemError('semantic_not_ready');
    return {
      ...value,
      ...(stored
        ? {
            title: stored.title,
            description: stored.description,
            visibility: stored.visibility,
            revision: stored.revision,
            presentationKind: stored.presentationKind,
            presentationKindSource: stored.presentationKind === null ? ('mixed' as const) : ('owner' as const),
            coverSource: stored.coverMediaId === null ? ('none' as const) : ('pending' as const),
          }
        : {}),
      ...(labels === undefined ? {} : { builtinLabels: labels }),
    };
  }
  async function discover(actor: Actor, after: string | null = null, limit = 100): Promise<BuiltinCollectionView[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 101)
      throw new RangeError('Builtin descriptor limit must be 1..101');
    return snapshot(async (client) => {
      const owner = await admitted(client, actor);
      if (!owner) return [];
      const presence = await readOwnerFactPresence(client, owner.accountId);
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
      for (const value of selected) {
        const stored = await storedDescriptor(client, owner.accountId, value.key);
        values.push(await present(client, owner.accountId, value.key, stored));
      }
      return values;
    });
  }
  const members = createBuiltinMembersApplication<
    BuiltinCollectionView,
    { filter: FilterDocument; releaseDigest: string; admission?: CollectionMemberAdmission },
    DynamicMemberView
  >({
    read: (actor, id, deadline) => read(actor, id, 'collection:read', deadline, true),
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
        return isOwnerEverythingEmpty(client, owner.accountId);
      }, deadline);
    },
    async readPage(actor, collectionId, options) {
      if (actor.kind !== 'account') throw new ProblemError('not_found');
      const { access, tokens } = config;
      if (!access || !tokens)
        throw new ProblemError('dependency_unavailable', {
          detail: 'Built-in members require current Access and cursor keys.',
        });
      const ledger = ownerQueryWork(options.limit, options.view ?? 'BASIC', options.deadline);
      if (options.source.builtinKind === 'everything' && options.source.revision === 0 && options.query?.admission) {
        const direct = await readLogicalEverythingMembers(
          { ...config, access, tokens },
          actor,
          collectionId,
          options.query.admission,
          options,
          options.deadline,
          ledger,
        );
        if (direct) return direct;
      }
      return readOwnerMembers(
        { ...config, access, tokens },
        {
          actor,
          collectionId,
          limit: options.limit,
          deadline: options.deadline,
          ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
          ...(options.query ? { query: options.query } : {}),
          ...(options.view === undefined ? {} : { view: options.view }),
          ...(options.languages === undefined ? {} : { languages: options.languages }),
          ledger,
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
  const originals = facts.map((fact) => fact.original);
  const observed = await consumeFollowWork(
    'identity.mapping',
    semanticObservationBound(ports.semanticObservations.follow.mappingWork(originals)),
    () => ports.readMappings(pool, originals),
    (result) => semanticObservationBound(result.work),
  );
  return facts.map((fact, index) => ({ fact, mapping: observed.value[index]! }));
}
