import { createHash } from 'node:crypto';
import { currentCommand, type CommandTransaction } from '../command/command.ts';
import type { ShelfDerivedPage } from './shelf-maintenance-ops-contract.ts';
import { readShelfDerivedAllocation } from './shelf-maintenance-runtime.ts';
import { newId, partitionOf, routeOf } from '../route/route.ts';
import type { ShelfTypeKeys, ShelfTypeResolution, ShelfWrite } from './shelf-contract.ts';
import { enterShelfWrite, NIL_SHELF_GENERATION } from './shelf-counter-owner.ts';
import { createNativeTypePreparationPorts } from './type-preparation.ts';
import type {
  TypePreparationContinuationDependencies,
  TypePreparationDependencies,
  TypePreparationPorts,
  TypePreparationEvidence,
} from './type-preparation-contract.ts';
import root from './shelf-type-key-root.sql';
import edge from './shelf-type-key-edge.sql';
import value from './shelf-type-key-value.sql';
import insertValue from './shelf-type-key-insert-value.sql';
import insertRoot from './shelf-type-key-insert-root.sql';
import reserve from './shelf-type-key-reserve.sql';
import reservation from './shelf-type-key-reservation.sql';
import chunk from './shelf-type-key-chunk.sql';
import insertEdge from './shelf-type-key-insert-edge.sql';
import progress from './shelf-type-key-progress.sql';
import publish from './shelf-type-key-publish.sql';
import finish from './shelf-type-key-finish.sql';

export type ShelfTypeDigest = (bytes: Buffer) => Buffer;
export type ShelfTypeKeysOptions = Readonly<{ digest?: ShelfTypeDigest }>;

export const SHELF_TYPE_DIGEST_ENV = 'KERNEL_LIBRARY_SHELF_TYPE_DIGEST';

export const sha256ShelfTypeDigest: ShelfTypeDigest = (bytes) => createHash('sha256').update(bytes).digest();

export function applyShelfTypeDigest(bytes: Buffer, digest: ShelfTypeDigest = sha256ShelfTypeDigest): Buffer {
  const result = digest(Buffer.from(bytes));
  if (!Buffer.isBuffer(result) || result.length !== 32) throw new TypeError('A shelf type digest must be 32 bytes');
  return Buffer.from(result);
}

/** A child worker may receive one fixed digest value as its per-world dictionary configuration. */
export function shelfTypeDigestFromEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): ShelfTypeDigest | undefined {
  const encoded = env[SHELF_TYPE_DIGEST_ENV];
  if (encoded === undefined) return undefined;
  const bytes = Buffer.from(encoded, 'base64url');
  if (bytes.length !== 32 || bytes.toString('base64url') !== encoded)
    throw new TypeError('Invalid kernel library shelf type digest configuration');
  return () => Buffer.from(bytes);
}

type Admission =
  | { kind: 'preparation'; evidence: TypePreparationEvidence }
  | { kind: 'maintenance'; page: ShelfDerivedPage; reservationId: string };
const admitted = new WeakMap<ShelfWrite['client'], Admission>();
const edges = new WeakMap<ShelfWrite['client'], number>();

/** Internal producer seam. The producer has already released current source observations and holds native evidence.
 * The token is scoped to this callback and exact live command, never carried in workflow JSON.
 */
async function withShelfTypePreparation<T>(
  write: ShelfWrite,
  evidence: TypePreparationEvidence,
  body: () => Promise<T>,
): Promise<T> {
  const command = currentCommand(write.client);
  if (
    command.authorization?.mode !== 'execute' ||
    command.partition !== partitionOf(write.route) ||
    evidence.binding.accountId !== write.accountId ||
    routeOf(evidence.preparationId) !== write.route
  )
    throw new TypeError('Type allocation requires the admitted preparation owner transaction');
  if (admitted.has(write.client)) throw new TypeError('Nested type preparation admission');
  admitted.set(write.client, { kind: 'preparation', evidence });
  try {
    return await body();
  } finally {
    admitted.delete(write.client);
  }
}
function owner(route: number, accountId: string) {
  partitionOf(route);
  if (routeOf(accountId) !== route) throw new TypeError('Private type dictionary owner route mismatch');
  return { route, account_id: accountId };
}
function exactBytes(fullType: string) {
  // Released Type syntax is validated by Semantic. This port only protects exact ASCII storage, with no size cap.
  if (typeof fullType !== 'string' || !/^[\x21-\x7e]+$/.test(fullType))
    throw new TypeError('A released Type must be nonempty ASCII');
  return Buffer.from(fullType, 'ascii');
}
async function admission(write: ShelfWrite) {
  owner(write.route, write.accountId);
  const proof = admitted.get(write.client);
  if (!proof) throw new TypeError('Type allocation requires current native preparation admission');
  if (proof.kind === 'maintenance') {
    const native = await readShelfDerivedAllocation(write.client as CommandTransaction, proof.page);
    if (native.owner.route !== write.route || native.owner.accountId !== write.accountId)
      throw new TypeError('Derived type dictionary owner mismatch');
    return { fenceId: native.runId, generationId: native.generationId, reservationId: proof.reservationId };
  }
  const gate = await enterShelfWrite(write);
  if (gate.epoch !== proof.evidence.binding.ownerEpoch) throw new Error('Type preparation owner epoch changed');
  // Post-publication retirement retains the active build. New ordinary reservations must belong to it.
  // The proven-empty nil generation cannot identify a reservation, so only that initial namespace uses its fence.
  const generationId =
    gate.generationId && gate.generationId !== NIL_SHELF_GENERATION ? gate.generationId : gate.fenceId;
  return { fenceId: gate.fenceId, generationId, reservationId: proof.evidence.reservationId };
}

/** Only the native runner's live WeakMap page can enter the shared dictionary core during rebuilding. */
export async function withShelfDerivedTypePreparation<T>(
  tx: CommandTransaction,
  page: ShelfDerivedPage,
  reservationId: string | null,
  body: () => Promise<T>,
): Promise<T> {
  const native = await readShelfDerivedAllocation(tx, page);
  if (admitted.has(tx)) throw new TypeError('Nested type preparation admission');
  admitted.set(tx, { kind: 'maintenance', page, reservationId: reservationId ?? newId(native.owner.route) });
  try {
    return await body();
  } finally {
    admitted.delete(tx);
  }
}

export function createShelfTypeKeys(options: ShelfTypeKeysOptions = {}): ShelfTypeKeys {
  const digestType = options.digest ?? sha256ShelfTypeDigest;
  async function lookup(client: ShelfWrite['client'], route: number, accountId: string, fullType: string) {
    const args = owner(route, accountId),
      bytes = exactBytes(fullType);
    const found = await root.run(client, {
      ...args,
      full_type: fullType,
      digest: applyShelfTypeDigest(bytes, digestType),
    });
    if (!found) return null;
    if (found.equal) return found.typeId;
    let nodeId = found.nodeId,
      terminal: string | null = null;
    for (let offset = 0; offset < bytes.length; offset += 256) {
      const next = await edge.run(client, { ...args, parent_id: nodeId, chunk: bytes.subarray(offset, offset + 256) });
      if (!next) return null;
      nodeId = next.nodeId;
      terminal = next.typeId;
    }
    if (!terminal) return null;
    return (await value.run(client, { ...args, type_id: terminal, full_type: fullType }))?.typeId ?? null;
  }
  async function advance(write: ShelfWrite, reservationId: string): Promise<ShelfTypeResolution> {
    const native = await admission(write);
    if (native.reservationId !== reservationId || routeOf(reservationId) !== write.route)
      throw new TypeError('Reservation is not bound to this preparation');
    const args = { ...owner(write.route, write.accountId), reservation_id: reservationId };
    const saved = await reservation.run(write.client, args);
    if (!saved || saved.fenceId !== native.fenceId || saved.generationId !== native.generationId)
      throw new Error('Type reservation is missing or retired');
    const start = BigInt(saved.offset),
      length = BigInt(saved.length);
    let offset = start,
      nodeId = saved.nodeId;
    const remainingEdges = 100 - (edges.get(write.client) ?? 0);
    const page =
      remainingEdges > 0 && offset < length
        ? await chunk.run(write.client, { ...args, offset: Number(offset), length: remainingEdges * 256 })
        : null;
    if (remainingEdges > 0 && offset < length && !page?.chunk?.length)
      throw new Error('Native type reservation page is missing');
    while (page?.chunk && offset < length && (edges.get(write.client) ?? 0) < 100) {
      const piece = page.chunk.subarray(Number(offset - start), Number(offset - start) + 256);
      if (!piece.length) throw new Error('Native type reservation chunk is missing');
      edges.set(write.client, (edges.get(write.client) ?? 0) + 1);
      let next = await edge.run(write.client, { ...args, parent_id: nodeId, chunk: piece });
      for (let attempt = 0; !next && attempt < 3; attempt++) {
        await insertEdge.run(write.client, { ...args, parent_id: nodeId, node_id: newId(write.route), chunk: piece });
        next = await edge.run(write.client, { ...args, parent_id: nodeId, chunk: piece });
      }
      if (!next) throw new Error('Native trie UUID allocation exhausted');
      nodeId = next.nodeId;
      offset += BigInt(piece.length);
    }
    const updated = await progress.run(write.client, {
      ...args,
      node_id: nodeId,
      previous_offset: start.toString(),
      next_offset: offset.toString(),
    });
    if (!updated) throw new Error('Type reservation checkpoint changed');
    if (offset < length) return { done: false, reservation: { reservationId } };
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await publish.run(write.client, {
        ...args,
        node_id: nodeId,
        type_id: attempt === 0 ? saved.candidateId : newId(write.route),
      });
      if (result[0]?.typeId) {
        await finish.run(write.client, args);
        return { done: true, typeId: result[0].typeId };
      }
    }
    throw new Error('Native type UUID allocation exhausted');
  }
  return {
    lookup,
    async reserve(write, fullType) {
      const native = await admission(write);
      const args = owner(write.route, write.accountId),
        bytes = exactBytes(fullType);
      const digest = applyShelfTypeDigest(bytes, digestType);
      const found = await root.run(write.client, { ...args, digest, full_type: fullType });
      if (found?.equal) return { done: true, typeId: found.typeId };
      if (!found) {
        for (let attempt = 0; attempt < 3; attempt++) {
          const typeId = newId(write.route);
          const inserted = await insertValue.run(write.client, { ...args, type_id: typeId, full_type: fullType });
          if (!inserted) continue;
          for (let rootAttempt = 0; rootAttempt < 3; rootAttempt++) {
            const insertedRoot = await insertRoot.run(write.client, {
              ...args,
              digest,
              type_id: typeId,
              node_id: newId(write.route),
            });
            if (insertedRoot[0]) return { done: true, typeId };
          }
          throw new Error('Native root UUID allocation exhausted');
        }
        throw new Error('Native type UUID allocation exhausted');
      }
      if (!native.reservationId) throw new TypeError('Collision allocation requires its native reservation identity');
      await reserve.run(write.client, {
        ...args,
        reservation_id: native.reservationId,
        full_type: fullType,
        digest,
        candidate_type_id: newId(write.route),
        node_id: found.nodeId,
        fence_id: native.fenceId,
        generation_id: native.generationId,
      });
      return advance(write, native.reservationId);
    },
    continue: (write, input) => advance(write, input.reservationId),
  };
}
/** Admission closure is private: callers cannot turn a constructed evidence object into writer authority. */
export function createTypePreparationPorts(dependencies: TypePreparationDependencies): TypePreparationPorts {
  return createNativeTypePreparationPorts(dependencies, withShelfTypePreparation);
}
export function createTypePreparationContinuation(
  dependencies: TypePreparationContinuationDependencies,
): Pick<TypePreparationPorts, 'continue'> {
  return { continue: createNativeTypePreparationPorts(dependencies, withShelfTypePreparation).continue };
}
export default createShelfTypeKeys;
