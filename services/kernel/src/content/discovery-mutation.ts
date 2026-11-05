import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool } from 'pg';
import { Value } from 'typebox/value';
import {
  authoritativeTimeValue,
  currentCommand,
  hasOwnCommandCompletion,
  noEffect,
  registerCommandCallback,
  runCommand,
  type AuthoritativeTime,
  type CommandAuthorization,
  type CommandEvent,
  type CommandTransaction,
  type PrincipalCommandIdentity,
  type PrincipalCommandReceipt,
} from '../command/command.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { withConnection } from '../database/pool.ts';
import type { Effect } from '../events/effects.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type { Access } from '../request/access.ts';
import {
  commitDiscoveryFence,
  projectDiscoveryOutcome,
  projectDiscoveryStart,
  prepareRealmDiscoverySource,
  readRealmDiscoveryEpoch,
} from '../community/discovery-source.ts';
import {
  DISCOVERY_OPERATION_EVENTS,
  DISCOVERY_PREPARED,
  DISCOVERY_OUTCOME,
  DISCOVERY_DELTA,
  DISCOVERY_EVENTS,
  type DiscoveryDelta,
} from './discovery-events.ts';
import { readDiscoverySource, retractDiscoveryStart } from './discovery.ts';
import target from './discovery-mutation-target.sql';
import read from './discovery-operation-read.sql';
import create from './discovery-operation-create.sql';
import phase from './discovery-operation-phase.sql';
import due from './discovery-operation-due.sql';
import restore from './discovery-restore.sql';
import board from './discovery-board.sql';
import envelope from './read-outbox-event-index.sql';

export type DiscoveryOperationReference = Readonly<{ route: number; intent: string; generation: string }>;
export type DiscoveryOperation = NonNullable<Awaited<ReturnType<typeof read.run>>>;
type Target = Readonly<{ kind: 'board' | 'thread' | 'post'; id: string }>;
type Dependencies = Readonly<{ pool: Pool; access: Access; clock?: () => Date }>;
type Command = Readonly<{
  identity: PrincipalCommandIdentity;
  authorization: CommandAuthorization;
  receipt: PrincipalCommandReceipt;
  deadline: number;
  target: Target;
  effect: 'retract' | 'restore';
}>;
const handles = new WeakMap<object, Pick<CommandAuthorization, 'action' | 'resource'>>();
const held = new WeakMap<CommandTransaction, DiscoveryOperation>();
const restoration = new WeakMap<AuthoritativeTime, boolean>();

/** Exact committed source evidence. This conveys no authority to mutate content. */
export async function readDiscoveryOperation(pool: Pool, ref: DiscoveryOperationReference) {
  return withConnection(pool, (client) => read.run(client, ref));
}
function reference(row: DiscoveryOperation): DiscoveryOperationReference {
  return Object.freeze({ route: row.route, intent: row.intent, generation: row.generation });
}
function event(type: string, ref: DiscoveryOperationReference): CommandEvent {
  return { type, subject: ref.intent, data: ref };
}
async function native(tx: CommandTransaction, targetRef: Target) {
  const rows = await target.run(tx, { route: routeOf(targetRef.id)!, kind: targetRef.kind, id: targetRef.id });
  if (rows.length > 1) throw new Error('Discovery target is not a point');
  return rows[0] ?? null;
}

/** OUTER source boundary: the requested command's exact actor/action/intent is
 * authorized again here, before preparation, and again by the original executor.
 * No token, authority snapshot, request body or person identity is journalled.
 */
export async function prepareDiscoveryMutation(
  deps: Dependencies,
  input: Command,
): Promise<DiscoveryOperationReference | null> {
  const route = routeOf(input.target.id)!;
  const intent = createHash('sha256')
    .update(
      canonicalize([
        input.identity,
        input.receipt.kind,
        input.receipt.key,
        Buffer.from(input.receipt.digest).toString('hex'),
        input.target,
      ])!,
    )
    .digest('hex');
  const prepared = await runCommand(
    deps.pool,
    {
      ...input.identity,
      partition: partitionOf(route),
      deadline: input.deadline,
      clock: deps.clock,
      authorization: input.authorization,
    },
    async (tx, { transactionId }) => {
      // Same-key authorized replay never opens another operation/fence.
      if (await hasOwnCommandCompletion(tx, input.receipt)) return noEffect<DiscoveryOperationReference | null>(null);
      const source = await native(tx, input.target);
      if (!source?.realm_id) return noEffect<DiscoveryOperationReference | null>(null);
      const epoch = source.realm_epoch === null ? await readRealmDiscoveryEpoch(tx, source.realm_id) : null;
      const realmEpoch = source.realm_epoch ?? epoch?.realm_epoch;
      const spaceId = source.space_id ?? epoch?.space_id;
      if (!realmEpoch || !spaceId) throw new Error('Discovery source binding unavailable');
      const previous = await read.run(tx, { route, intent, generation: '0' });
      if (previous && previous.phase !== 'aborted') return noEffect(reference(previous));
      const generation = String(BigInt(previous?.generation ?? '0') + 1n);
      await create.run(tx, {
        route,
        intent,
        generation,
        kind: input.target.kind,
        effect: input.effect,
        id: input.target.id,
        native_version: source.native_version,
        source_version: source.source_version,
        thread_id: source.thread_id,
        board_id: source.board_id,
        realm_id: source.realm_id,
        space_id: spaceId,
        realm_epoch: realmEpoch,
        transaction_id: transactionId,
      });
      const ref = Object.freeze({ route, intent, generation });
      return { value: ref, events: [event(DISCOVERY_PREPARED, ref)] };
    },
  );
  const ref = prepared.value;
  if (!ref) return null;
  // Each phase releases its checkout before the next home is opened.
  try {
    await readyDiscoveryMutation(deps.pool, ref);
  } catch (error) {
    await abortDiscoveryMutation(deps.pool, ref);
    throw error;
  }
  handles.set(ref, { action: input.authorization.action, resource: input.authorization.resource });
  return ref;
}

export async function readyDiscoveryMutation(pool: Pool, ref: DiscoveryOperationReference): Promise<void> {
  const fenceGeneration = await commitDiscoveryFence(pool, ref);
  await runCommand(pool, { partition: partitionOf(ref.route), deadline: Date.now() + 30_000 }, async (tx) => {
    const row = await read.run(tx, ref);
    if (!row) throw new Error('Discovery preparation unavailable');
    if (row.phase !== 'prepared') return noEffect(null);
    await phase.run(tx, {
      ...ref,
      expected: 'prepared',
      phase: 'ready',
      fence_generation: fenceGeneration,
      transaction_id: null,
      projected: false,
    });
    return { value: null, events: [event(DISCOVERY_PREPARED, ref)] };
  });
}

/** Fresh native Access preparation remains outside the source transaction. Only
 * an original-public source in its original epoch may regain contribution.
 */
export function discoveryMutationAuthorization(
  deps: Dependencies,
  authorization: CommandAuthorization,
  ref: DiscoveryOperationReference | null,
): CommandAuthorization {
  if (!ref) return authorization;
  return {
    ...authorization,
    async prepare(attempt) {
      const proof = await authorization.prepare?.(attempt);
      const row = await readDiscoveryOperation(deps.pool, ref);
      if (row?.effect === 'restore') {
        const binding = await prepareRealmDiscoverySource(deps, row.realm_id, attempt.time, Date.now() + 30_000);
        const currentBoard = await board.run(deps.pool, {
          route: routeOf(row.board_id)!,
          board_id: row.board_id,
          at: authoritativeTimeValue(attempt.time),
        });
        restoration.set(
          attempt.time,
          !!binding &&
            !!currentBoard &&
            currentBoard.realm_id === row.realm_id &&
            binding.realmEpoch === row.realm_epoch &&
            binding.spaceId === row.space_id,
        );
      }
      return proof;
    },
  };
}

/** Runs after the original executor's fresh authorization and receipt lookup,
 * inside its original transaction. Recovery and application lock the SAME row.
 */
export async function lockDiscoveryMutation(tx: CommandTransaction, ref: DiscoveryOperationReference | null) {
  if (!ref) return;
  const expected = handles.get(ref);
  const command = currentCommand(tx);
  const authority = command.authorization;
  if (
    !expected ||
    command.partition !== partitionOf(ref.route) ||
    authority?.mode !== 'execute' ||
    authority.action !== expected.action ||
    authority.resource.route !== expected.resource.route ||
    authority.resource.id !== expected.resource.id
  )
    throw new GrantDeniedError();
  const row = await read.run(tx, ref);
  if (!row || row.phase !== 'ready' || row.fence_generation === null) throw new GrantDeniedError();
  const source = await native(tx, { kind: row.target_kind as Target['kind'], id: row.target_id });
  if (!source || source.native_version !== row.native_version || source.source_version !== row.source_version)
    throw new GrantDeniedError();
  // A board can contain starts from a newly public epoch. Its local Realm epoch
  // must still be the one fenced before this source mutation.
  if (row.target_kind === 'board') {
    const binding = await readRealmDiscoveryEpoch(tx, row.realm_id);
    if (!binding || binding.realm_epoch !== row.realm_epoch) throw new GrantDeniedError();
  }
  held.set(tx, row);
}

/** Low-level native composition cannot mutate an originally qualifying target
 * without the outer operation lock. Global/unqualified resources retain their
 * existing trusted composition behavior.
 */
export async function assertDiscoveryMutationLocked(tx: CommandTransaction, targetRef: Target): Promise<void> {
  const source = await native(tx, targetRef);
  if (source?.thread_id && (!held.has(tx) || held.get(tx)!.target_id !== targetRef.id)) throw new GrantDeniedError();
}
export function requireDiscoverySourceLock(tx: CommandTransaction, threadId: string): void {
  if (held.get(tx)?.thread_id !== threadId) throw new GrantDeniedError();
}

/** Validates the real native version change; callers cannot assert success. The
 * outcome transaction id is supplied by the executor callback, never by a caller.
 */
export async function applyDiscoveryMutation(
  tx: CommandTransaction,
  ref: DiscoveryOperationReference | null,
): Promise<CommandEvent[]> {
  if (!ref) return [];
  const row = held.get(tx);
  if (!row || row.intent !== ref.intent || row.generation !== ref.generation) throw new GrantDeniedError();
  const source = await native(tx, { kind: row.target_kind as Target['kind'], id: row.target_id });
  if (!source) throw new Error('Discovery native outcome unavailable');
  const changed = BigInt(source.native_version) === BigInt(row.native_version) + 1n;
  if (!changed && source.native_version !== row.native_version) throw new GrantDeniedError();
  const events: CommandEvent[] = [];
  if (changed && row.thread_id) {
    if (row.effect === 'retract') events.push(...(await retractDiscoveryStart(tx, { threadId: row.thread_id })));
    else if (restoration.get(currentCommand(tx).time)) {
      const restored = await restore.run(tx, {
        route: row.route,
        thread_id: row.thread_id,
        source_version: row.source_version,
        realm_epoch: row.realm_epoch,
      });
      if (restored)
        events.push({
          type: DISCOVERY_DELTA,
          subject: row.thread_id,
          data: {
            realmId: restored.realm_id,
            realmEpoch: restored.realm_epoch,
            spaceId: restored.space_id,
            boardId: restored.board_id,
            threadId: restored.thread_id,
            sourceRoute: restored.route,
            creationDay: restored.creation_day,
            sourceVersion: restored.source_version,
            contributing: true,
            change: 1,
          },
        });
    }
  }
  registerCommandCallback(tx, async (transactionId) => {
    await phase.run(tx, {
      ...ref,
      expected: 'ready',
      phase: changed ? 'applied' : 'aborted',
      fence_generation: null,
      transaction_id: transactionId,
      projected: false,
    });
  });
  held.delete(tx);
  return [...events, event(DISCOVERY_OUTCOME, ref)];
}

/** Explicit resolution after the source executor has returned failure. A locked
 * terminal CAS proves absence of application and makes any late effect impossible.
 * A lost response whose transaction committed is APPLIED and must be projected.
 * Live/unknown operations are never selected for timeout-based abortion.
 */
export async function abortDiscoveryMutation(pool: Pool, ref: DiscoveryOperationReference | null): Promise<void> {
  if (!ref) return;
  await runCommand(
    pool,
    { partition: partitionOf(ref.route), deadline: Date.now() + 30_000 },
    async (tx, { transactionId }) => {
      const row = await read.run(tx, ref);
      if (!row || row.phase === 'applied' || row.phase === 'aborted') return noEffect(null);
      await phase.run(tx, {
        ...ref,
        expected: row.phase,
        phase: 'aborted',
        fence_generation: null,
        transaction_id: transactionId,
        projected: false,
      });
      return { value: null, events: [event(DISCOVERY_OUTCOME, ref)] };
    },
  );
}

export async function projectDiscoveryMutation(pool: Pool, ref: DiscoveryOperationReference): Promise<void> {
  await projectDiscoveryOutcome(pool, ref);
  await runCommand(pool, { partition: partitionOf(ref.route), deadline: Date.now() + 30_000 }, async (tx) => {
    const row = await read.run(tx, ref);
    if (!row || row.projected) return noEffect(null);
    if (row.phase !== 'applied' && row.phase !== 'aborted') throw new Error('Discovery outcome remains live');
    await phase.run(tx, {
      ...ref,
      expected: row.phase,
      phase: row.phase,
      fence_generation: null,
      transaction_id: null,
      projected: true,
    });
    return { value: null, events: [event(DISCOVERY_OUTCOME, ref)] };
  });
}

/** Fixed fifty terminal keys per recovery step, across the partition's sixteen
 * exact route ranges. Unknown/live rows are never timeout-aborted.
 */
export async function recoverDiscoveryMutations(pool: Pool, partition: number) {
  let remaining = 50;
  for (let offset = 0; offset < 16 && remaining > 0; offset++) {
    const rows = await due.run(pool, { route: partition * 16 + offset, limit: remaining });
    for (const row of rows) await projectDiscoveryMutation(pool, row);
    remaining -= rows.length;
  }
}

export function createDiscoveryMutationEffect(pool: Pool): Effect {
  return {
    name: 'content_realm_discovery_source',
    types: [DISCOVERY_PREPARED, DISCOVERY_OUTCOME, DISCOVERY_DELTA],
    async run(event) {
      if (event.type === DISCOVERY_DELTA) {
        if (!Value.Check(DISCOVERY_EVENTS[DISCOVERY_DELTA], event.data)) throw new TypeError('Invalid discovery delta');
        const delta = event.data as DiscoveryDelta;
        const source = /^urn:rezics:log:(\d+)\.([1-9][0-9]*)$/.exec(event.source);
        if (
          !source ||
          Number(source[1]) !== partitionOf(delta.sourceRoute) ||
          !/^\d{19}$/.test(event.sequence) ||
          event.subject !== delta.threadId
        )
          throw new TypeError('Invalid discovery delta source');
        const original = await envelope.run(pool, {
          partition_no: Number(source[1]),
          epoch: Number(source[2]),
          position: event.sequence,
          id: event.id,
          type: event.type,
          subject: event.subject,
          data: event.data,
        });
        if (!original) throw new Error('Discovery delta envelope unavailable');
        await projectDiscoveryStart(pool, delta);
        return;
      }
      const schema = DISCOVERY_OPERATION_EVENTS[event.type as keyof typeof DISCOVERY_OPERATION_EVENTS];
      if (!schema || !Value.Check(schema, event.data)) throw new TypeError('Invalid discovery operation event');
      const ref = event.data as DiscoveryOperationReference;
      const source = /^urn:rezics:log:(\d+)\.([1-9][0-9]*)$/.exec(event.source);
      if (
        !source ||
        Number(source[1]) !== partitionOf(ref.route) ||
        !/^\d{19}$/.test(event.sequence) ||
        event.subject !== ref.intent
      )
        throw new TypeError('Invalid discovery operation source');
      const original = await envelope.run(pool, {
        partition_no: Number(source[1]),
        epoch: Number(source[2]),
        position: event.sequence,
        id: event.id,
        type: event.type,
        subject: event.subject,
        data: event.data,
      });
      if (!original) throw new Error('Discovery operation envelope unavailable');
      const row = await readDiscoveryOperation(pool, ref);
      if (!row) throw new Error('Discovery operation unavailable');
      if (row.phase === 'prepared' || row.phase === 'ready') await readyDiscoveryMutation(pool, ref);
      else await projectDiscoveryMutation(pool, ref);
    },
  };
}

/** Exact source state for the Community native projection, never a success callback. */
export async function readDiscoveryOutcome(pool: Pool, ref: DiscoveryOperationReference) {
  const operation = await readDiscoveryOperation(pool, ref);
  if (!operation || !['applied', 'aborted'].includes(operation.phase) || !operation.outcome_transaction_id)
    throw new Error('Discovery outcome remains unavailable');
  const current = await withConnection(pool, (client) =>
    native(client, {
      kind: operation.target_kind as Target['kind'],
      id: operation.target_id,
    }),
  );
  const source = operation.thread_id ? await readDiscoverySource(pool, operation.thread_id) : null;
  if (!current || (operation.phase === 'applied' && BigInt(current.native_version) <= BigInt(operation.native_version)))
    throw new Error('Discovery native application unavailable');
  return { operation, current, source };
}
