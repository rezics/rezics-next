import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { PoolClient } from 'pg';
import {
  authoritativeTimeValue,
  currentCommand,
  noEffect,
  normalizeCommandKey,
  principalCommandIdentity,
  type CommandResult,
  type AuthoritativeTime,
} from '../command/command.ts';
import { nativeReceiptKeyCandidates } from '../command/receipt-key.ts';
import readReceipt from '../command/read-receipt.sql';
import { requireAccessDeadline } from '../access/unavailable.ts';
import { withRequestDeadline, deadlineFor } from '../request/deadline.ts';
import type { Actor } from '../request/access.ts';
import { newId, partitionOf, routeOf } from '../route/route.ts';
import { withReadTransaction } from '../semantic/read.ts';
import { createLibraryCommandRunner, LibraryNotFoundError, WORK_STEP_DEADLINE_MS } from './command-support.ts';
import { admitEntryAttempt } from './entry-lifecycle.ts';
import { resolveSubject } from './subject-anchor.ts';
import { enterShelfWrite } from './shelf-counter-owner.ts';
import { preparationHeaderCommitment, type PreparationHeaderCommitment } from './preparation-bindings.ts';
import { readPreparationNativeHeader, type NativePreparationHeader } from './preparation-native-reader.ts';
import {
  typePreparationBinding,
  type PreparedType,
  type TypePreparationContinuationDependencies,
  type TypePreparationDependencies,
  type TypePreparationEvidence,
  type TypePreparationPorts,
  type TypePreparationResult,
  type TypePreparationIntent,
} from './type-preparation-contract.ts';
import latest from './type-preparation-latest.sql';
import readProgress from './type-preparation-progress-read.sql';
import readSlot from './type-preparation-slot-read.sql';
import writeSlot from './type-preparation-slot-write.sql';
import writeHeader from './type-preparation-header-write.sql';
import writeProgress from './type-preparation-progress-write.sql';
import equal from './type-preparation-equal.sql';
import readReservation from './shelf-type-key-reservation.sql';
import ownerCurrent from './type-preparation-owner-current.sql';
import preparationTime from './type-preparation-time.sql';
import type { ShelfWrite } from './shelf-contract.ts';

type Client = Pick<PoolClient, 'query'>;
type Checkpoint = { state: string; typeId: string | null; chunk: string; offset: string; nodeId: string | null };
type CreateValue = string | { preparationId: string; metadataCommitment: string; checkpoint: Checkpoint } | null;
type Native = { header: NativePreparationHeader; checkpoint: Checkpoint };
const hash = (value: unknown) => createHash('sha256').update(canonicalize(value)!).digest();
const eq = (a: unknown, b: unknown) => canonicalize(a) === canonicalize(b);
function locator(accountId: string, preparationId: string) {
  const route = routeOf(accountId);
  if (route === null || routeOf(preparationId) !== route) throw new TypeError('Invalid preparation owner locator');
  return { route, account_id: accountId, preparation_id: preparationId };
}
function evidence(h: PreparationHeaderCommitment): TypePreparationEvidence {
  return {
    preparationId: h.preparationId,
    binding: h.binding,
    origin: h.origin,
    sourceIdentity: h.sourceIdentity,
    originIdentity: h.originIdentity,
    reservationId: h.reservationId,
  };
}
function result(native: Native): TypePreparationResult {
  const h = native.header,
    p = native.checkpoint;
  if (p.state === 'ready' && p.typeId)
    return { status: 'ready', prepared: { evidence: evidence(h), typeId: p.typeId } };
  if (p.state !== 'pending') return { status: 'refresh' };
  const chunk = Number(p.chunk),
    offset = Number(p.offset);
  if (!Number.isSafeInteger(chunk) || !Number.isSafeInteger(offset))
    throw new Error('Invalid native preparation checkpoint');
  return { status: 'pending', intent: { evidence: evidence(h), chunk, offset } };
}

/** Authenticates creator AND current checkpoint receipts. Neither JSON nor the provenance reader grants readiness. */
async function load(client: Client, accountId: string, preparationId: string): Promise<Native | null> {
  const args = locator(accountId, preparationId);
  const header = await readPreparationNativeHeader(client, { route: args.route, accountId, preparationId });
  if (!header) return null;
  const progress = await readProgress.run(client, args);
  if (!progress || !progress.receipt || !progress.transactionId) return null;
  const receipt = progress.receipt as PreparationHeaderCommitment['creationReceipt'];
  if (
    receipt.partition !== partitionOf(args.route) ||
    receipt.principalKind !== 'account' ||
    receipt.principalId !== accountId ||
    !['library.type-preparation.create', 'library.type-preparation.page'].includes(receipt.commandKind) ||
    typeof receipt.key !== 'string' ||
    typeof receipt.digest !== 'string'
  )
    return null;
  const actual = await readReceipt.run(client, {
    partition_no: receipt.partition,
    principal_kind: 'account',
    principal_id: accountId,
    command_kind: receipt.commandKind,
    idempotency_keys: nativeReceiptKeyCandidates(client, receipt.commandKind, accountId, receipt.key),
  });
  const checkpoint: Checkpoint = {
    state: progress.state,
    typeId: progress.typeId,
    chunk: progress.chunk,
    offset: progress.offset,
    nodeId: progress.nodeId,
  };
  const response = actual?.response as {
    preparationId?: unknown;
    metadataCommitment?: unknown;
    checkpoint?: unknown;
  } | null;
  if (
    !actual ||
    actual.transactionId !== progress.transactionId ||
    Buffer.from(actual.requestDigest).toString('hex') !== receipt.digest ||
    response?.preparationId !== preparationId ||
    response.metadataCommitment !== header.creationCommitment ||
    !eq(response.checkpoint, checkpoint) ||
    BigInt(checkpoint.offset) > BigInt(header.inputByteLength)
  )
    return null;
  if (checkpoint.state === 'ready' && !checkpoint.typeId) return null;
  return { header, checkpoint };
}

export function createNativeTypePreparationPorts(
  deps: TypePreparationDependencies | TypePreparationContinuationDependencies,
  withShelfTypePreparation: <T>(
    write: ShelfWrite,
    evidence: TypePreparationEvidence,
    body: () => Promise<T>,
  ) => Promise<T>,
): TypePreparationPorts {
  const runner = createLibraryCommandRunner(deps);
  function fullDependencies(): TypePreparationDependencies {
    if (!('access' in deps))
      throw new TypeError('User preparation requires the installed Access and full source observer');
    return deps;
  }
  const validated = new WeakMap<PreparedType, { native: Native; namespace: unknown; deadline: number }>();
  async function current(h: PreparationHeaderCommitment) {
    const source = await deps.observeIdentity(h.binding.sourceId);
    if (!eq(source.identity, h.sourceIdentity)) return false;
    if (h.origin.sourceId === h.binding.sourceId) return eq(source.identity, h.originIdentity);
    return eq((await deps.observeIdentity(h.origin.sourceId)).identity, h.originIdentity);
  }
  async function authorized(actor: Actor, h: PreparationHeaderCommitment, at?: AuthoritativeTime) {
    const resolved = await resolveSubject(fullDependencies(), actor, h.binding.subjectId, at);
    return resolved?.subjectId === h.binding.sourceId;
  }
  async function snapshot(accountId: string, preparationId: string) {
    return withReadTransaction(deps.pool, async (client) => {
      const native = await load(client, accountId, preparationId);
      if (!native) return null;
      const owner = await ownerCurrent.run(client, {
        ...locator(accountId, preparationId),
        epoch: native.header.binding.ownerEpoch,
      });
      return owner ? native : null;
    });
  }
  function commitment(header: PreparationHeaderCommitment) {
    const { creationCommitment: _, ...immutable } = header as NativePreparationHeader;
    return preparationHeaderCommitment(immutable);
  }
  async function persist(
    client: Client,
    header: PreparationHeaderCommitment,
    checkpoint: Checkpoint,
    receipt: PreparationHeaderCommitment['creationReceipt'],
    transactionId: string,
  ) {
    await writeProgress.run(client, {
      ...locator(header.accountId, header.preparationId),
      state: checkpoint.state,
      type_id: checkpoint.typeId,
      chunk: checkpoint.chunk,
      offset: checkpoint.offset,
      node_id: checkpoint.nodeId,
      receipt,
      transaction_id: transactionId,
    });
    return {
      value: { preparationId: header.preparationId, metadataCommitment: commitment(header), checkpoint },
      events: [
        {
          type: 'com.rezics.library.type-preparation.changed.v1',
          subject: header.accountId,
          data: { preparationId: header.preparationId },
        },
      ],
    };
  }
  async function checkpoint(
    client: Client,
    h: PreparationHeaderCommitment,
    typeId: string | null,
    previousChunk: bigint,
  ): Promise<Checkpoint> {
    if (typeId)
      return {
        state: 'ready',
        typeId,
        chunk: (previousChunk + 1n).toString(),
        offset: h.inputByteLength,
        nodeId: null,
      };
    const r =
      h.reservationId &&
      (await readReservation.run(client, {
        ...locator(h.accountId, h.preparationId),
        reservation_id: h.reservationId,
      }));
    if (!r) throw new Error('Pending preparation reservation is missing');
    return {
      state: 'pending',
      typeId: null,
      chunk: (previousChunk + 1n).toString(),
      offset: r.offset,
      nodeId: r.nodeId,
    };
  }
  async function prepare(
    actor: Actor,
    input: { subjectId: string; requestKey: string },
  ): Promise<TypePreparationResult> {
    const full = fullDependencies();
    if (actor.kind !== 'account') throw new LibraryNotFoundError();
    const route = routeOf(actor.accountId);
    if (route === null || routeOf(input.subjectId) === null) throw new LibraryNotFoundError();
    normalizeCommandKey({ kind: 'account', id: actor.accountId }, input.requestKey);
    const deadline = deadlineFor(WORK_STEP_DEADLINE_MS),
      namespace = principalCommandIdentity(actor);
    const preparationId = newId(route),
      reservationId = newId(route),
      kind = 'library.type-preparation.create';
    const commandInput = { subjectId: input.subjectId, requestKey: input.requestKey, preparationId };
    const key = `create:${preparationId}`,
      digest = hash([namespace, kind, commandInput]);
    const outcome = await runner.ownAccountPrepared(
      actor,
      {
        action: 'library_entry:update',
        kind,
        requestKey: key,
        input: commandInput,
        async prepare(attempt) {
          await admitEntryAttempt(full, actor, 'library_entry:update', attempt, deadline);
          const previous = await withReadTransaction(deps.pool, async (client) => {
            const found = await latest.run(client, {
              route,
              account_id: actor.accountId,
              subject_id: input.subjectId,
              request_key: input.requestKey,
              principal_namespace: namespace,
            });
            const native = found ? await load(client, actor.accountId, found.preparationId) : null;
            if (!native) return null;
            const gate = await ownerCurrent.run(client, {
              route,
              account_id: actor.accountId,
              epoch: native.header.binding.ownerEpoch,
            });
            return gate ? native : null;
          });
          if (
            previous &&
            previous.checkpoint.state !== 'cancelled' &&
            (await current(previous.header)) &&
            (await authorized(actor, previous.header, attempt.time))
          )
            return { previous };
          const resolved = await resolveSubject(full, actor, input.subjectId, attempt.time);
          if (!resolved) throw new LibraryNotFoundError();
          const origin = await full.observe(input.subjectId);
          if (
            !origin.identity ||
            origin.identity.redirect !== (resolved.subjectId === input.subjectId ? null : resolved.subjectId)
          )
            return null;
          const source = resolved.subjectId === input.subjectId ? origin : await full.observe(resolved.subjectId);
          if (!source.identity || source.identity.redirect !== null || source.type === null) return null;
          await full.typeSourceObserved?.({
            accountId: actor.accountId,
            subjectId: input.subjectId,
            sourceId: resolved.subjectId,
            stamp: { ...source.stamp },
          });
          requireAccessDeadline(deadline);
          return { source, origin, sourceId: resolved.subjectId };
        },
      },
      async (tx, command, observed): Promise<CommandResult<CreateValue>> => {
        requireAccessDeadline(deadline);
        if (!observed) return noEffect(null);
        const write = { client: tx, route, accountId: actor.accountId },
          gate = await enterShelfWrite(write);
        if ('previous' in observed) {
          const fresh = await load(tx, actor.accountId, observed.previous.header.preparationId);
          return noEffect(fresh && fresh.header.binding.ownerEpoch === gate.epoch ? fresh.header.preparationId : null);
        }
        const { source, origin, sourceId } = observed;
        const binding = typePreparationBinding({
          accountId: actor.accountId,
          subjectId: input.subjectId,
          requestKey: input.requestKey,
          sourceId,
          source: source.stamp,
          ownerEpoch: BigInt(gate.epoch),
        });
        const originBinding = {
          sourceId: input.subjectId,
          partition: origin.stamp.partition,
          epoch: origin.stamp.epoch,
          position: origin.stamp.position.toString(),
          survivorId: origin.identity!.redirect,
        };
        const bindingDigest = hash([binding, namespace]).toString('hex');
        const slot = await readSlot.run(tx, { route, account_id: actor.accountId, binding_digest: bindingDigest });
        if (slot) {
          const existing = await load(tx, actor.accountId, slot.preparationId);
          if (existing && existing.checkpoint.state !== 'cancelled') {
            if (
              !eq(existing.header.binding, binding) ||
              !eq(existing.header.principalNamespace, namespace) ||
              !(
                await equal.run(tx, {
                  route,
                  account_id: actor.accountId,
                  full_type: source.type!,
                  reservation_id: existing.header.reservationId,
                  type_id: existing.checkpoint.typeId,
                })
              ).equal
            )
              throw new Error('Equal preparation binding has unequal native input');
            return noEffect(existing.header.preparationId);
          }
        }
        const initialEvidence: TypePreparationEvidence = {
          preparationId,
          binding,
          origin: originBinding,
          sourceIdentity: source.identity!,
          originIdentity: origin.identity!,
          reservationId,
        };
        const resolved = await withShelfTypePreparation(write, initialEvidence, () =>
          deps.keys.reserve(write, source.type!),
        );
        const fullBytes = Buffer.from(source.type!, 'ascii');
        const receipt = {
          partition: partitionOf(route),
          principalKind: 'account' as const,
          principalId: actor.accountId,
          commandKind: kind,
          key,
          digest: digest.toString('hex'),
        };
        const timestamp = await preparationTime.run(tx, { at: authoritativeTimeValue(command.time) });
        if (!timestamp?.at) throw new TypeError('Missing preparation timestamp');
        const at = timestamp.at;
        const header: PreparationHeaderCommitment = {
          version: 1,
          route,
          accountId: actor.accountId,
          preparationId,
          binding,
          origin: originBinding,
          sourceIdentity: source.identity!,
          originIdentity: origin.identity!,
          principalNamespace: namespace,
          reservationId: resolved.done ? null : reservationId,
          inputByteLength: fullBytes.length.toString(),
          inputDigest: createHash('sha256').update(fullBytes).digest('hex'),
          creationTransactionId: command.transactionId,
          creationReceipt: receipt,
          createdAt: at,
        };
        const commitment = preparationHeaderCommitment(header);
        await writeHeader.run(tx, {
          ...locator(actor.accountId, preparationId),
          binding_digest: bindingDigest,
          binding,
          origin: originBinding,
          principal_namespace: namespace,
          reservation_id: header.reservationId,
          input_byte_length: header.inputByteLength,
          input_digest: Buffer.from(header.inputDigest, 'hex'),
          transaction_id: command.transactionId,
          receipt,
          commitment,
          time: at,
          source_identity: source.identity,
          origin_identity: origin.identity,
        });
        await writeSlot.run(tx, { ...locator(actor.accountId, preparationId), binding_digest: bindingDigest });
        const p = await checkpoint(tx, header, resolved.done ? resolved.typeId : null, 0n);
        return persist(tx, header, p, receipt, command.transactionId);
      },
    );
    const value = outcome.value;
    const id = typeof value === 'string' ? value : value?.preparationId;
    const native = id ? await snapshot(actor.accountId, id) : null;
    return native ? result(native) : { status: 'refresh' };
  }
  const ports: TypePreparationPorts = {
    prepare: (actor, input) => withRequestDeadline(deadlineFor(WORK_STEP_DEADLINE_MS), () => prepare(actor, input)),
    async continue(intent: TypePreparationIntent) {
      const { accountId } = intent.evidence.binding,
        preparationId = intent.evidence.preparationId;
      const args = locator(accountId, preparationId),
        kind = 'library.type-preparation.page';
      const key = `page:${preparationId}:${intent.chunk}:${intent.offset}`;
      const namespace = { principal: { kind: 'account', id: accountId }, basis: null };
      const receipt = {
        partition: partitionOf(args.route),
        principalKind: 'account' as const,
        principalId: accountId,
        commandKind: kind,
        key,
        digest: hash([namespace, kind, intent]).toString('hex'),
      };
      const observations = new WeakMap<AuthoritativeTime, Native | null>();
      await runner.trustedAccount(
        accountId,
        { kind, stepKey: key, input: intent },
        async (tx, command): Promise<CommandResult<CreateValue>> => {
          const before = observations.get(command.time);
          const write = { client: tx, route: args.route, accountId },
            gate = await enterShelfWrite(write);
          const native = await load(tx, accountId, preparationId);
          if (
            !native ||
            !eq(evidence(native.header), intent.evidence) ||
            native.header.binding.ownerEpoch !== gate.epoch ||
            native.checkpoint.state !== 'pending' ||
            native.checkpoint.chunk !== String(intent.chunk) ||
            native.checkpoint.offset !== String(intent.offset)
          )
            return noEffect(null);
          const h = native.header;
          if (!before) {
            const p = { ...native.checkpoint, state: 'cancelled' };
            return persist(tx, h, p, receipt, command.transactionId);
          }
          if (!h.reservationId) throw new Error('Pending preparation has no reservation');
          const resolved = await withShelfTypePreparation(write, evidence(h), () =>
            deps.keys.continue(write, { reservationId: h.reservationId! }),
          );
          const p = await checkpoint(tx, h, resolved.done ? resolved.typeId : null, BigInt(native.checkpoint.chunk));
          return persist(tx, h, p, receipt, command.transactionId);
        },
        async (attempt) => {
          const native = await snapshot(accountId, preparationId);
          observations.set(attempt.time, native && (await current(native.header)) ? native : null);
        },
      );
      const native = await snapshot(accountId, preparationId);
      if (!native || !(await current(native.header))) return { status: 'cancelled' };
      const next = result(native);
      return next.status === 'pending'
        ? { status: 'advanced', next: next.intent }
        : next.status === 'ready'
          ? next
          : { status: 'cancelled' };
    },
    async revalidate(actor, prepared) {
      validated.delete(prepared);
      if (actor.kind !== 'account' || actor.accountId !== prepared.evidence.binding.accountId) return 'refresh';
      const full = fullDependencies(),
        deadline = deadlineFor(WORK_STEP_DEADLINE_MS);
      const outcome = await runner.ownAccountPrepared(
        actor,
        {
          action: 'library_entry:update',
          kind: 'library.type-preparation.revalidate',
          requestKey: newId(routeOf(actor.accountId)!),
          input: { preparationId: prepared.evidence.preparationId },
          async prepare(attempt) {
            await admitEntryAttempt(full, actor, 'library_entry:update', attempt, deadline);
            const native = await snapshot(actor.accountId, prepared.evidence.preparationId);
            if (
              !native ||
              native.checkpoint.state !== 'ready' ||
              native.checkpoint.typeId !== prepared.typeId ||
              !eq(evidence(native.header), prepared.evidence) ||
              !eq(native.header.principalNamespace, principalCommandIdentity(actor)) ||
              !(await current(native.header)) ||
              !(await authorized(actor, native.header, attempt.time))
            )
              return null;
            return native;
          },
        },
        async (tx, _command, native) => {
          const gate = await enterShelfWrite({
            client: tx,
            route: routeOf(actor.accountId)!,
            accountId: actor.accountId,
          });
          return noEffect(native && native.header.binding.ownerEpoch === gate.epoch ? native : null);
        },
      );
      if (!outcome.value) return 'refresh';
      requireAccessDeadline(deadline);
      validated.set(prepared, { native: outcome.value, namespace: principalCommandIdentity(actor), deadline });
      return 'current';
    },
    async consume(tx, prepared) {
      const validation = validated.get(prepared),
        command = currentCommand(tx);
      if (
        !validation ||
        Date.now() >= validation.deadline ||
        command.authorization?.mode !== 'execute' ||
        command.authorization.action !== 'library_entry:update' ||
        command.authorization.resource.id !== prepared.evidence.binding.accountId
      )
        return { status: 'refresh' };
      const basis = command.basis;
      if (
        !basis ||
        !eq(validation.namespace, {
          principal: { kind: 'account', id: basis.actorAccountId },
          basis: { clientId: basis.clientId, requestedBy: basis.requestedBy },
        })
      )
        return { status: 'refresh' };
      const h = validation.native.header,
        gate = await enterShelfWrite({ client: tx, route: h.route, accountId: h.accountId });
      const native = await load(tx, h.accountId, h.preparationId);
      if (
        !native ||
        gate.epoch !== h.binding.ownerEpoch ||
        !eq(native, validation.native) ||
        !eq(evidence(native.header), prepared.evidence) ||
        native.checkpoint.typeId !== prepared.typeId
      )
        return { status: 'refresh' };
      return {
        status: 'ready',
        typeId: prepared.typeId,
        sourceId: h.binding.sourceId,
        stamp: {
          partition: h.binding.sourcePartition,
          epoch: h.binding.sourceEpoch,
          position: BigInt(h.binding.sourcePosition),
        },
      };
    },
  };
  return ports;
}
