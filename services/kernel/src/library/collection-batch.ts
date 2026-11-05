import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import type { AuthoritativeTime, CommandEvent, CommandOutcome, CommandTransaction } from '../command/command.ts';
import { ProblemError } from '../http/problem.ts';
import type { Access, Actor } from '../request/access.ts';
import { newId, routeOf } from '../route/route.ts';
import type { Collection, CollectionMember } from './collection-model.ts';
import { deleteMembers, readCollection, readMember } from './collection-store.ts';
import { planCollectionPlacement } from './collection-order-placement.ts';
import { readableSubjects } from './subject-anchor.ts';
import lockParents from './collection-batch-lock.sql';
import selectedMembers from './collection-batch-selected.sql';
import prepareMembers from './collection-batch-prepare.sql';
import removalMembers from './collection-batch-remove-prepare.sql';
import transfer from './collection-batch-transfer.sql';
import finish from './collection-batch-finish.sql';
import respace from './collection-batch-respace.sql';
import deferOrdinals from './collection-batch-defer.sql';

type Context = { transactionId: string; time: string };
export type CollectionMutator = <T>(
  actor: Actor,
  collectionId: string,
  action: 'collection:update' | 'collection:delete',
  kind: string,
  requestKey: string,
  input: unknown,
  body: (
    tx: CommandTransaction,
    command: Context,
    route: number,
  ) => Promise<{ value: T; events: readonly CommandEvent[] }>,
  destinationCollectionId?: string,
  prepareMembers?: (time: AuthoritativeTime) => Promise<void>,
) => Promise<CommandOutcome<T>>;
type Selection = { revision: number; memberIds: string[] };
type Move = Selection & { destinationCollectionId: string; destinationRevision: number; after: string | null };

function invalid(): never {
  throw new ProblemError('invalid_request');
}
function missing(): never {
  throw new ProblemError('not_found');
}
function conflict(): never {
  throw new ProblemError('conflict');
}
function revision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) invalid();
  return value;
}
function selection(input: Selection): string[] {
  revision(input?.revision);
  const ids = input.memberIds;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100 || new Set(ids).size !== ids.length) invalid();
  for (const id of ids) if (typeof id !== 'string' || routeOf(id) === null) invalid();
  return ids;
}
function event(collectionId: string, member: CollectionMember): CommandEvent {
  return {
    type: 'com.rezics.library.collection.member.changed.v1',
    subject: collectionId,
    data: { collectionId, memberId: member.id, subjectId: member.subjectId },
  };
}
async function parent(tx: CommandTransaction, route: number, id: string): Promise<Collection> {
  const value = await readCollection(tx, route, id);
  if (!value || value.state !== 'active') missing();
  return value;
}
async function selected(tx: CommandTransaction, route: number, collectionId: string, ids: string[]) {
  const rows = await selectedMembers.run(tx, { route, collection_id: collectionId, ids });
  if (rows.length !== ids.length) missing();
  return rows.map((row) => {
    if (row.addedAt === null || row.ordinalKey === null) missing();
    return { ...row, addedAt: new Date(row.addedAt).toISOString(), ordinalKey: row.ordinalKey };
  });
}
async function lock(tx: CommandTransaction, route: number, ids: string[]) {
  const rows = await lockParents.run(tx, { route, ids: [...ids].sort() });
  if (rows.length !== ids.length) missing();
  for (const row of rows) if (row.membershipKind !== 'curated') throw new ProblemError('dynamic_membership_immutable');
  return rows;
}

export function createCollectionBatchCommands(
  deps: { pool: Pool; access: Access; clock?: KernelClock },
  mutate: CollectionMutator,
) {
  return { batchRemoveMembers, transferMembers };

  async function batchRemoveMembers(actor: Actor, collectionId: string, input: Selection, key: string) {
    const ids = selection(input);
    return mutate(
      actor,
      collectionId,
      'collection:update',
      'library.collection.members.batchRemove',
      key,
      { collectionId, ...input },
      async (tx, command, route) => {
        const [current] = await lock(tx, route, [collectionId]);
        if (current!.revision !== input.revision) conflict();
        const members = await selected(tx, route, collectionId, ids);
        const removed = await deleteMembers(
          tx,
          route,
          collectionId,
          members.map((member) => ({ memberId: member.id, deletionId: newId(route) })),
          input.revision,
          command,
        );
        if (removed.length !== members.length) conflict();
        return {
          value: {
            collection: await parent(tx, route, collectionId),
            removed: removed.map((member) => ({
              memberId: member.id,
              deletionId: member.deletionId,
              revision: member.revision,
            })),
          },
          events: members.map((member) => event(collectionId, member)),
        };
      },
      undefined,
      async (time) => {
        const members = await removalMembers.run(deps.pool, {
          route: routeOf(collectionId)!,
          collection_id: collectionId,
          ids,
        });
        if (members.length !== ids.length) missing();
        const originals = [...new Set(members.map((member) => member.subjectId))];
        if ((await readableSubjects(deps, actor, originals, time)).length !== originals.length) missing();
      },
    );
  }

  async function transferMembers(actor: Actor, collectionId: string, input: Move, key: string) {
    const ids = selection(input);
    revision(input.destinationRevision);
    if (typeof input.destinationCollectionId !== 'string' || routeOf(input.destinationCollectionId) === null) missing();
    if (collectionId === input.destinationCollectionId) invalid();
    if (routeOf(collectionId) !== routeOf(input.destinationCollectionId))
      throw new ProblemError('collection_move_unsupported');
    if (input.after !== null && (typeof input.after !== 'string' || routeOf(input.after) === null)) invalid();
    const destinationId = input.destinationCollectionId;
    let prepared = new Map<string, string>();
    let preparedAfter: string | null = null;
    return mutate(
      actor,
      collectionId,
      'collection:update',
      'library.collection.members.transfer',
      key,
      { collectionId, ...input },
      async (tx, command, route) => {
        const parents = await lock(tx, route, [collectionId, destinationId]);
        const source = parents.find((row) => row.id === collectionId)!;
        const destination = parents.find((row) => row.id === destinationId)!;
        if (source.curatorAccountId !== destination.curatorAccountId)
          throw new ProblemError('collection_move_unsupported');
        if (source.revision !== input.revision || destination.revision !== input.destinationRevision) conflict();
        const members = await selected(tx, route, collectionId, ids);
        if (members.some((member) => prepared.get(member.id) !== member.subjectId)) missing();
        if (input.after !== null) {
          const anchor = await readMember(tx, route, destinationId, input.after);
          if (!anchor || preparedAfter !== anchor.subjectId) missing();
        }
        if (destination.memberCount + ids.length > 5_000) throw new ProblemError('collection_full');
        const plan = await planCollectionPlacement(
          tx,
          route,
          destinationId,
          input.after === null ? { kind: 'first' } : { kind: 'after', memberId: input.after },
          members.map((member) => member.id),
        );
        const keys = plan.keys;
        const respaced = plan.members.length > 0;
        if (respaced) {
          await deferOrdinals.run(tx);
          const respaceInput: (typeof respace)['~reylo']['input'] = {
            route,
            collection_id: destinationId,
            items: plan.members.map((member) => ({ member_id: member.memberId, ordinal_key: member.ordinalKey })),
            transaction_id: command.transactionId,
          };
          const values = respace.params.map((name) =>
            name === 'items' ? JSON.stringify(respaceInput.items) : respaceInput[name as keyof typeof respaceInput],
          );
          const { rows: updated } = await tx.query<(typeof respace)['~reylo']['element']>(respace.sql, values);
          if (updated.length !== plan.members.length) conflict();
        }
        const moved: CollectionMember[] = [];
        for (let index = 0; index < members.length; index++) {
          const member = members[index]!;
          const rows = await transfer.run(tx, {
            route,
            source_id: collectionId,
            destination_id: destinationId,
            member_id: member.id,
            ordinal_key: keys[index]!,
            transaction_id: command.transactionId,
          });
          if (rows.length !== 1) conflict();
          moved.push({ ...member, collectionId: destinationId, ordinalKey: keys[index]! });
        }
        for (const [id, suppliedRevision, delta, spaced] of [
          [collectionId, input.revision, -members.length, 0],
          [destinationId, input.destinationRevision, members.length, Number(respaced)],
        ] as const) {
          const rows = await finish.run(tx, {
            route,
            collection_id: id,
            revision: suppliedRevision,
            delta,
            respace: spaced,
            time: command.time,
            transaction_id: command.transactionId,
          });
          if (rows.length !== 1) conflict();
        }
        return {
          value: {
            source: await parent(tx, route, collectionId),
            destination: await parent(tx, route, destinationId),
            members: moved,
          },
          events: members.flatMap((member) => [event(collectionId, member), event(destinationId, member)]),
        };
      },
      destinationId,
      async (time) => {
        // Read only the addressed current rows, release the owning connection, then visit subject homes.
        // Replay still rechecks disclosure for occurrences now in the destination before exposing its receipt.
        const current = await prepareMembers.run(deps.pool, {
          route: routeOf(collectionId)!,
          source_id: collectionId,
          destination_id: destinationId,
          ids,
        });
        const anchor =
          input.after === null ? null : await readMember(deps.pool, routeOf(collectionId)!, destinationId, input.after);
        if (current.length !== ids.length || (input.after !== null && !anchor)) missing();
        const originals = [
          ...new Set([...current.map((member) => member.subjectId), ...(anchor ? [anchor.subjectId] : [])]),
        ];
        const readable = new Set<string>();
        for (let index = 0; index < originals.length; index += 100)
          for (const id of await readableSubjects(deps, actor, originals.slice(index, index + 100), time))
            readable.add(id);
        if (originals.some((id) => !readable.has(id))) missing();
        prepared = new Map(current.map((member) => [member.id, member.subjectId]));
        preparedAfter = anchor?.subjectId ?? null;
      },
    );
  }
}
