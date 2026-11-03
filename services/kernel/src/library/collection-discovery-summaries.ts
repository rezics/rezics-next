/** Native public Collection card hydration. Search candidates and index hints carry no authority here. */
import { deadlineClient } from '../access/authenticate.ts';
import { AccessUnavailableError, CommandUnavailableError, requireAccessDeadline } from '../access/unavailable.ts';
import { mintReadTime, releaseOperationalTime, type AuthoritativeTime } from '../command/command.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';
import { prepareReadDecisions, type Actor } from '../request/access.ts';
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

export const MAX_COLLECTION_DISCOVERY_SUMMARIES = 100;
export type PublicCollectionDiscoveryContext = Readonly<{
  actor: Actor;
  /** The single native owner partition, not an index partition or an inferred actor home. */
  partition: number;
  deadline: number;
  /** Borrowed native read time. Hydration never releases a caller-owned capability. */
  time?: AuthoritativeTime;
}>;
export type PublicCollectionDiscoveryRequest = Readonly<{
  ids: readonly string[];
  context: PublicCollectionDiscoveryContext;
}>;
type Card = Omit<CollectionPresentation, 'coverMediaId'> &
  Readonly<{
    kind: 'collection';
    id: string;
    destination: `/collections/${string}`;
    title: string;
    description: string | null;
    visibility: 'public';
    revision: number;
  }>;
export type PublicCollectionDiscoverySummary = Card &
  (
    | Readonly<{
        membershipKind: 'curated';
        memberCount: number;
        orderEpoch: number;
        createdAt: string;
        updatedAt: string;
      }>
    | Readonly<{ membershipKind: 'dynamic'; outputGeneration: string }>
  );
export type PublicCollectionDiscoveryResult =
  | Readonly<{ state: 'ready'; summaries: readonly PublicCollectionDiscoverySummary[] }>
  | Readonly<{
      state: 'unavailable';
      reason: 'native_authority' | 'changed' | 'access' | 'partition' | 'deadline';
    }>;
export type PublicCollectionDiscoveryDependencies = PresentationDependencies;

type Row = Awaited<ReturnType<typeof rowsQuery.run>>[number];
type Observed = {
  row: Row;
  output: CollectionOutputPublication | null;
  authority: boolean;
  signature: string;
};
type Round = {
  epoch: number;
  node: string;
  rows: ReadonlyMap<string, Observed>;
};

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
      const observed = new Map<string, Observed>();
      for (const row of visible) {
        const output = outputs.get(row.id) ?? null;
        observed.set(row.id, {
          row,
          output,
          authority: nativeAuthority(row, output),
          signature: signature(row, output),
        });
      }
      await client.query('COMMIT');
      return { epoch: partition.epoch, node: partition.node, rows: observed };
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
): PublicCollectionDiscoverySummary {
  const { row, output } = observed;
  const common: Card = {
    ...presentation,
    kind: 'collection',
    id: row.id,
    destination: `/collections/${row.id}`,
    title: row.title,
    description: row.description,
    visibility: 'public',
    revision: row.revision,
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
): Promise<PublicCollectionDiscoveryResult> {
  const admitted = request(ids, context);
  if (!admitted.ids.length) return { state: 'ready', summaries: [] };
  const unavailable = (reason: Extract<PublicCollectionDiscoveryResult, { state: 'unavailable' }>['reason']) =>
    ({ state: 'unavailable', reason }) as const;
  try {
    const hydrate = async (): Promise<PublicCollectionDiscoveryResult> => {
      const before = await round(dependencies, admitted.ids, admitted.context);
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
      const final = await round(dependencies, admitted.ids, admitted.context);
      if (before.epoch !== final.epoch || before.node !== final.node) return unavailable('changed');
      const summaries: PublicCollectionDiscoverySummary[] = [];
      for (const id of admitted.ids) {
        const current = final.rows.get(id);
        // Current withdrawal/denial wins, even when the earlier observation was unavailable.
        if (!current) continue;
        const original = before.rows.get(id);
        if (!original) continue; // Newly public candidates can be picked up by the next request.
        if (!current.authority || !original.authority) return unavailable('native_authority');
        if (current.signature !== original.signature) return unavailable('changed');
        summaries.push(card(current, presentations.get(id)!));
      }
      requireAccessDeadline(admitted.context.deadline);
      return { state: 'ready', summaries };
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
