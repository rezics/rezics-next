/** Native public Collection card hydration. Search candidates and index hints carry no authority here. */
import { createHash } from 'node:crypto';
import {
  prepareCollectionDiscoveryContext,
  readDiscoveryMemberKeys,
  readDiscoverySubjectMembership,
  type CollectionDiscoveryContext,
  type CollectionCurator,
  type CollectionDiscoveryContextFilters,
  type DiscoveryMemberKey,
} from './collection-discovery-context.ts';
import { deadlineClient } from './access-port.ts';
import { requireAccessDeadline } from '../access/unavailable.ts';
import { AccessUnavailableError, CommandUnavailableError } from '../access/contract/errors.ts';
import { mintReadTime, releaseOperationalTime, type AuthoritativeTime } from '../command/command.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';
import {
  readFollowCountHealthObservation,
  type FollowCountHealthObservation,
} from './adapters/follow-count-observation.ts';
import { readCollectionDiscoveryFollowCounts } from './adapters/follow-count-discovery.ts';
import { FollowCountUnavailableError } from './contract/index.ts';
import { prepareReadDecisions } from '../request/access-check.ts';
import type { Actor } from '../request/access.ts';
import { PARTITIONS, partitionOf, routeOf } from '../route/route.ts';
import {
  collectionPresentation,
  readablePresentationCover,
  type CollectionPresentation,
  type PresentationDependencies,
} from './collection-presentation.ts';
import { readDiscoveryOutputs } from './collection-discovery-summaries-output.ts';
import rowsQuery from './collection-discovery-summaries-rows.sql';
import type { CollectionOutputPublication } from './collection-source-output.ts';
import type { PublicCollectionDiscoverySummary } from './contract/index.ts';
import type {
  CollectionDiscoveryQuery,
  CollectionDiscoveryRecency,
  CollectionPresentationKind,
} from './collection-discovery-source.ts';

export const MAX_COLLECTION_DISCOVERY_SUMMARIES = 100;
export type PublicCollectionDiscoveryContext = Readonly<{
  actor: Actor;
  /** The single native owner partition, not an index partition or an inferred actor home. */
  partition: number;
  deadline: number;
  /** Borrowed native read time. Hydration never releases a caller-owned capability. */
  time?: AuthoritativeTime;
  languages?: readonly string[];
}>;
export type PublicCollectionDiscoveryRequest = Readonly<{
  ids: readonly string[];
  context: PublicCollectionDiscoveryContext;
}>;
type Card = Omit<CollectionPresentation, 'coverMediaId'> &
  CollectionDiscoveryContext &
  Readonly<{
    kind: 'collection';
    id: string;
    destination: `/collections/${string}`;
    title: string;
    description: string | null;
    visibility: 'public';
    revision: number;
    sourceGeneration: string;
  }>;
export type PublicCollectionDiscoveryOperand = Readonly<{
  id: string;
  presentationKind: CollectionPresentationKind;
  curator: CollectionCurator;
  subjectMembership:
    | Readonly<{ state: 'available'; subjectId: string; matches: boolean }>
    | Readonly<{ state: 'withheld' }>
    | null;
  popularity: Readonly<{ followers: string }> | null;
  recency: CollectionDiscoveryRecency;
  eligible: Readonly<{
    presentationKind: boolean | null;
    curator: boolean | null;
    subject: boolean | null;
  }>;
}>;
export type PublicCollectionDiscoveryResult =
  | Readonly<{
      state: 'ready';
      summaries: readonly PublicCollectionDiscoverySummary[];
      operands: readonly PublicCollectionDiscoveryOperand[];
      queryObservation: string;
    }>
  | Readonly<{
      state: 'unavailable';
      reason: 'native_authority' | 'changed' | 'access' | 'partition' | 'deadline' | 'follow_count';
    }>;
export type PublicCollectionDiscoveryDependencies = PresentationDependencies;

type Row = Awaited<ReturnType<typeof rowsQuery.run>>[number];
type Observed = {
  row: Row;
  output: CollectionOutputPublication | null;
  authority: boolean;
  signature: string;
  members: readonly DiscoveryMemberKey[];
  subjectMatches: boolean | null;
  followers: string | null;
};
type Round = {
  epoch: number;
  node: string;
  position: string;
  followCountHealth?: FollowCountHealthObservation;
  rows: ReadonlyMap<string, Observed>;
};

function presentationMatches(
  filter: CollectionPresentationKind | undefined,
  presentationKind: CollectionPresentationKind,
): boolean | null {
  if (!filter) return null;
  return filter.kind === 'mixed'
    ? presentationKind.kind === 'mixed'
    : presentationKind.kind === 'owner' && presentationKind.id === filter.id;
}

function recency(row: Row): CollectionDiscoveryRecency {
  return [row.membershipKind === 'curated' ? row.updatedAtEpochMicros : null, row.route, row.id];
}

function operand(
  observed: Observed,
  curator: CollectionCurator,
  query: CollectionDiscoveryQuery,
  queryCurator: CollectionCurator | null | undefined,
  querySubject: { id: string } | null | undefined,
): PublicCollectionDiscoveryOperand {
  const presentationKind: CollectionPresentationKind =
    observed.row.presentationKind === null ? { kind: 'mixed' } : { kind: 'owner', id: observed.row.presentationKind };
  const subjectMembership =
    query.subjectId === undefined
      ? null
      : querySubject
        ? { state: 'available' as const, subjectId: query.subjectId, matches: observed.subjectMatches ?? false }
        : { state: 'withheld' as const };
  return {
    id: observed.row.id,
    presentationKind,
    curator,
    subjectMembership,
    popularity: query.popularity ? (observed.followers === null ? null : { followers: observed.followers }) : null,
    recency: recency(observed.row),
    eligible: {
      presentationKind: presentationMatches(query.presentationKind, presentationKind),
      curator:
        query.curatorAccountId === undefined
          ? null
          : queryCurator?.state === 'available' && curator.state === 'available'
            ? queryCurator.id === curator.id
            : false,
      subject: query.subjectId === undefined ? null : querySubject ? (observed.subjectMatches ?? false) : null,
    },
  };
}

/** Copy and validate the complete request before Access preparation or any owner checkout. */
function request(ids: readonly string[], context: PublicCollectionDiscoveryContext) {
  if (
    !context ||
    !Number.isInteger(context.partition) ||
    context.partition < 0 ||
    context.partition >= PARTITIONS ||
    !Number.isFinite(context.deadline) ||
    !context.actor ||
    (context.actor.kind !== 'anonymous' && context.actor.kind !== 'account') ||
    !Array.isArray(ids) ||
    ids.length > MAX_COLLECTION_DISCOVERY_SUMMARIES
  )
    throw new RangeError('Invalid public Collection discovery request');
  for (const id of ids) {
    const route = routeOf(id);
    if (route === null || partitionOf(route) !== context.partition)
      throw new RangeError('Public Collection discovery requires full keys in one partition');
  }
  const actor: Actor =
    context.actor.kind === 'anonymous'
      ? { kind: 'anonymous' }
      : {
          ...context.actor,
          scopes: [...context.actor.scopes],
        };
  return { ids: [...new Set(ids)], context: { ...context, actor } };
}

function publicRow(row: Row): boolean {
  return row.state === 'active' && row.visibility === 'public';
}

/** A null curator is accepted only on the existing native retained curated header. Dynamic
 * retention cannot be inferred from de-identification, a cached head or a deleted account.
 */
function nativeAuthority(row: Row, output: CollectionOutputPublication | null): boolean {
  if (row.membershipKind === 'curated')
    return row.deidentified || (row.ownerState !== null && row.ownerState !== 'deleted');
  return (
    row.membershipKind === 'dynamic' &&
    !row.deidentified &&
    row.ownerState !== null &&
    row.ownerState !== 'deleted' &&
    output !== null
  );
}

function signature(row: Row, output: CollectionOutputPublication | null): string {
  // The internal observation is never spread into a DTO. It includes terminal owner evidence,
  // source incarnation and actual selected publication, including its independent member fence.
  return JSON.stringify([row, output]);
}

async function round(
  dependencies: PublicCollectionDiscoveryDependencies,
  ids: readonly string[],
  context: PublicCollectionDiscoveryContext,
  query: CollectionDiscoveryQuery = {},
): Promise<Round> {
  requireAccessDeadline(context.deadline);
  // Foreign authority is prepared while no Library connection is held. Repeat on final disclosure.
  const decisions = await prepareReadDecisions(dependencies.access, {
    actor: context.actor,
    actions: new Set(['collection:read']),
    ...(context.time ? { time: context.time } : {}),
    context: { pool: dependencies.pool, deadline: context.deadline, ...(context.time ? { time: context.time } : {}) },
  });
  return withConnection(dependencies.pool, async (connection) => {
    const client = deadlineClient(connection, context.deadline);
    let ownedTime: AuthoritativeTime | undefined;
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const time = context.time ?? (ownedTime = await mintReadTime(client, dependencies.clock));
      const partition = await readPartition(client, context.partition);
      if (!partition || partition.writeState !== 'active' || partition.movedTo !== null)
        throw new CommandUnavailableError('fenced', context.partition);
      const rows = await rowsQuery.run(client, { routes: ids.map((id) => routeOf(id)!), ids: [...ids] });
      const byId = new Map(rows.map((row) => [row.id, row]));
      if (rows.length > ids.length || byId.size !== rows.length || rows.some((row) => !ids.includes(row.id)))
        throw new Error('Native Collection discovery returned unexpected keys');
      const allowed = await decisions.decide(
        client,
        {
          action: 'collection:read',
          resourceType: 'library.collection',
          ids,
          // All facts are owner-read in this snapshot. No hints, caller flags or ordinary grant
          // can turn unlisted/private/inactive metadata into a public discovery contribution.
          eligibility: async () =>
            Object.fromEntries(ids.map((id) => [id, !!byId.get(id) && publicRow(byId.get(id)!)])),
        },
        time,
      );
      if (ids.some((id) => typeof allowed[id]?.allowed !== 'boolean')) throw new AccessUnavailableError('overloaded');
      const visible = rows.filter((row) => publicRow(row) && allowed[row.id]!.allowed);
      const outputs = await readDiscoveryOutputs(
        client,
        visible.filter((row) => row.membershipKind === 'dynamic'),
      );
      const memberKeys = await readDiscoveryMemberKeys(
        client,
        visible.map((row) => ({ ...row, outputGeneration: outputs.get(row.id)?.generation ?? null })),
      );
      const contextSources = visible.map((row) => ({
        ...row,
        outputGeneration: outputs.get(row.id)?.generation ?? null,
      }));
      const subjectMembership =
        query.subjectId === undefined
          ? new Map<string, boolean>()
          : await readDiscoverySubjectMembership(client, contextSources, query.subjectId);
      const followCountHealth = query.popularity ? await readFollowCountHealthObservation(client) : undefined;
      const followCounts = query.popularity
        ? await readCollectionDiscoveryFollowCounts(
            client,
            visible.map((row) => ({ route: row.route, id: row.id })),
          )
        : new Map<string, string | null>();
      if (
        query.popularity &&
        visible.some((row) => followCounts.get(row.id) === undefined || followCounts.get(row.id) === null)
      )
        throw new FollowCountUnavailableError('A public Collection follow total is unavailable');
      const observed = new Map<string, Observed>();
      for (const row of visible) {
        const output = outputs.get(row.id) ?? null;
        const subjectMatches = query.subjectId === undefined ? null : (subjectMembership.get(row.id) ?? false);
        const followers = query.popularity ? followCounts.get(row.id)! : null;
        observed.set(row.id, {
          row,
          output,
          authority: nativeAuthority(row, output),
          members: memberKeys.get(row.id) ?? [],
          subjectMatches,
          followers,
          signature: JSON.stringify([
            signature(row, output),
            memberKeys.get(row.id) ?? [],
            subjectMatches,
            followers,
            followCountHealth ?? null,
          ]),
        });
      }
      await client.query('COMMIT');
      return {
        epoch: partition.epoch,
        node: partition.node,
        position: partition.position.toString(),
        ...(followCountHealth ? { followCountHealth } : {}),
        rows: observed,
      };
    } catch (error) {
      try {
        await connection.query('ROLLBACK');
      } catch (cleanup) {
        discardConnection(connection, cleanup instanceof Error ? cleanup : new Error('Read rollback failed'));
      }
      throw error;
    } finally {
      if (ownedTime) releaseOperationalTime(ownedTime);
    }
  });
}

function card(
  observed: Observed,
  presentation: Omit<CollectionPresentation, 'coverMediaId'>,
  context: CollectionDiscoveryContext,
): PublicCollectionDiscoverySummary {
  const { row, output } = observed;
  const common: Card = {
    ...presentation,
    ...context,
    kind: 'collection',
    id: row.id,
    destination: `/collections/${row.id}`,
    title: row.title,
    description: row.description,
    visibility: 'public',
    revision: row.revision,
    sourceGeneration: row.sourceGeneration,
  };
  if (row.membershipKind === 'dynamic') {
    if (!output) throw new Error('A dynamic discovery card requires actual native output authority');
    return { ...common, membershipKind: 'dynamic', outputGeneration: output.generation };
  }
  return {
    ...common,
    membershipKind: 'curated',
    memberCount: row.memberCount,
    orderEpoch: row.orderEpoch,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

/** One deduplicated native batch, followed by fresh authority and version revalidation. The result
 * contains each still-readable identity at most once, in first-requested order. Unavailability
 * never returns a partial card list; legitimate missing/denied/withdrawn candidates are omitted.
 */
export async function readPublicCollectionDiscoverySummaries(
  dependencies: PublicCollectionDiscoveryDependencies,
  ids: readonly string[],
  context: PublicCollectionDiscoveryContext,
  query: CollectionDiscoveryQuery = {},
): Promise<PublicCollectionDiscoveryResult> {
  const admitted = request(ids, context);
  if (!admitted.ids.length)
    return {
      state: 'ready',
      summaries: [],
      operands: [],
      queryObservation: createHash('sha256')
        .update(JSON.stringify([admitted.context.partition, query]))
        .digest('hex'),
    };
  const unavailable = (reason: Extract<PublicCollectionDiscoveryResult, { state: 'unavailable' }>['reason']) =>
    ({ state: 'unavailable', reason }) as const;
  try {
    const hydrate = async (): Promise<PublicCollectionDiscoveryResult> => {
      const before = await round(dependencies, admitted.ids, admitted.context, query);
      const presentations = new Map<string, Omit<CollectionPresentation, 'coverMediaId'>>();
      // Content owns media permission/variant validation. Its capabilities and connections are
      // released before Library's final snapshot; no ordinary Collection read or query runs here.
      for (const [id, observed] of before.rows) {
        if (!observed.authority) continue;
        const cover =
          observed.row.coverMediaId === null
            ? null
            : await readablePresentationCover(
                dependencies,
                admitted.context.actor,
                observed.row.coverMediaId,
                admitted.context.deadline,
              );
        presentations.set(id, collectionPresentation(observed.row, cover));
      }
      const publicContext = await prepareCollectionDiscoveryContext(
        dependencies.routeKey
          ? { ...dependencies, routeKey: dependencies.routeKey, deadline: admitted.context.deadline }
          : null,
        [...before.rows.values()]
          .filter((value) => value.authority)
          .map(({ row, output }) => ({ ...row, outputGeneration: output?.generation ?? null })),
        new Map([...before.rows].map(([id, observed]) => [id, observed.members])),
        admitted.context.languages,
        {
          ...(query.subjectId === undefined ? {} : { subjectId: query.subjectId }),
          ...(query.curatorAccountId === undefined ? {} : { curatorAccountId: query.curatorAccountId }),
        },
      );
      const final = await round(dependencies, admitted.ids, admitted.context, query);
      if (
        before.epoch !== final.epoch ||
        before.node !== final.node ||
        before.position !== final.position ||
        JSON.stringify(before.followCountHealth ?? null) !== JSON.stringify(final.followCountHealth ?? null)
      )
        return unavailable('changed');
      if (!(await publicContext.current())) return unavailable('changed');
      const summaries: PublicCollectionDiscoverySummary[] = [];
      const operands: PublicCollectionDiscoveryOperand[] = [];
      for (const id of admitted.ids) {
        const current = final.rows.get(id);
        // Current withdrawal/denial wins, even when the earlier observation was unavailable.
        if (!current) continue;
        const original = before.rows.get(id);
        if (!original) continue; // Newly public candidates can be picked up by the next request.
        if (!current.authority || !original.authority) return unavailable('native_authority');
        if (current.signature !== original.signature) return unavailable('changed');
        summaries.push(card(current, presentations.get(id)!, publicContext.values.get(id)!));
        operands.push(
          operand(
            current,
            publicContext.values.get(id)!.curator,
            query,
            publicContext.queryCurator,
            publicContext.querySubject,
          ),
        );
      }
      requireAccessDeadline(admitted.context.deadline);
      const queryObservation = createHash('sha256')
        .update(
          JSON.stringify({
            partition: admitted.context.partition,
            epoch: final.epoch,
            node: final.node,
            position: final.position,
            context: publicContext.observation,
            query,
            followCountHealth: final.followCountHealth ?? null,
            rows: admitted.ids.flatMap((id) => {
              const row = final.rows.get(id);
              return row ? [[id, row.signature]] : [];
            }),
            operands,
          }),
        )
        .digest('hex');
      return { state: 'ready', summaries, operands, queryObservation };
    };
    return await hydrate();
  } catch (error) {
    if (error instanceof AccessUnavailableError)
      return unavailable(error.reason === 'deadline' ? 'deadline' : 'access');
    if (error instanceof CommandUnavailableError) return unavailable('partition');
    // SQL, media, programming and unrelated infrastructure failures remain observable to callers.
    throw error;
  }
}
