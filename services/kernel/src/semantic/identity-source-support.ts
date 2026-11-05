import canonicalize from 'canonicalize';
import { createHash } from 'node:crypto';
import { releaseDigest } from '@rezics/definitions';
import { classifyUnavailability, requireAccessDeadline } from '../access/unavailable.ts';
import { withRequestDeadline } from '../request/deadline.ts';
import { withReadTransaction } from './read.ts';
import { readPartition } from '../partition/partition.ts';
import { routeOf } from '../route/route.ts';
import { seal, unseal, type KeyRing } from '../tokens/seal.ts';
import type { IdentityJobRef } from './identity-epoch-contract.ts';
import { identityEpochStore, identityJobPartition } from './identity-adapters/index.ts';
import { withIdentitySourceSupportJob } from './identity-source-support-scope.ts';
import type {
  IdentitySourceSupportReaderFactory,
  IdentitySourceSupportRequest,
} from './identity-source-support-contract.ts';
import { createPublicFilterSourceBinding } from './public-filter-source-binding.ts';
import { publicFilterSource } from './public-filter-source.ts';
import type { PublicFilterCost, PublicFilterProjectionFrontier } from './public-filter-source-contract.ts';
import { readIdentitySourceProjection } from './search-source.ts';
import inputsStatement from './identity-source-support-inputs.sql';
import originalsStatement from './identity-source-support-originals.sql';
import groupsStatement from './identity-source-support-groups.sql';
import stepStatement from './identity-epoch-store-select-step.sql';
import controlStatement from './identity-epoch-store-select-control.sql';

const SCOPE = 'semantic.identity-source-support';
const zero = (): PublicFilterCost => ({
  inputKeys: 0,
  candidates: 0,
  accessPoints: 0,
  dependencyPoints: 0,
  engineSearches: 0,
  engineIteratorSteps: 0,
  outputSlots: 0,
  resultWrites: 0,
  frontierWrites: 0,
});
const add = (a: PublicFilterCost, b: PublicFilterCost): PublicFilterCost =>
  Object.fromEntries(
    Object.entries(a).map(([key, value]) => [key, value + b[key as keyof PublicFilterCost]]),
  ) as PublicFilterCost;
const digest = (value: unknown) => createHash('sha256').update(canonicalize(value)!).digest('hex');
const sameJob = (a: IdentityJobRef, b: IdentityJobRef) => a.jobId === b.jobId && a.epoch === b.epoch;
type Input = {
  terminal: string;
  generation: string;
  basis_version: string;
  original_count: string;
  control_partition: number;
  owner_epoch: number;
};
type Cursor = {
  basis: string;
  segment: number;
  after: string | null;
  pending: string | null;
  projection: {
    build: string;
    generation: string;
    continuation: string;
  } | null;
};
class SupportState extends Error {
  constructor(readonly status: 'changed' | 'unready' | 'unavailable') {
    super(status);
  }
}

function validate(request: IdentitySourceSupportRequest): void {
  if (
    !request ||
    !request.job ||
    routeOf(request.job.jobId) === null ||
    typeof request.job.epoch !== 'bigint' ||
    request.job.epoch <= 0n
  )
    throw new TypeError('Support requires an actual native identity job reference');
  if (!Number.isInteger(request.inputLimit) || request.inputLimit < 1 || request.inputLimit > 1000)
    throw new RangeError('Support inputLimit must be an integer from 1 through 1000');
  if (request.frontier !== null && (typeof request.frontier !== 'string' || request.frontier.length > 4096))
    throw new TypeError('Invalid support frontier');
  if (!request.context || !Number.isFinite(request.context.deadline))
    throw new TypeError('Support requires a deadline');
  const definition = request.definition;
  if (
    !definition ||
    !definition.source ||
    typeof definition.source.id !== 'string' ||
    !definition.source.id ||
    !Number.isInteger(definition.source.partition) ||
    definition.source.partition < 0 ||
    definition.source.partition >= 4096 ||
    !Number.isInteger(definition.source.epoch) ||
    definition.source.epoch < 1 ||
    typeof definition.source.configuration !== 'string' ||
    !definition.source.configuration ||
    typeof definition.readDefinition !== 'string' ||
    !definition.readDefinition ||
    !definition.meaning ||
    releaseDigest(definition.meaning.release) !== definition.meaning.digest ||
    !Object.hasOwn(definition.meaning.release.types, definition.meaning.type)
  )
    throw new TypeError('Invalid native Source definition');
}

function cursor(ring: KeyRing, value: string | null): Cursor | null {
  if (value === null) return null;
  const decoded = unseal(ring, SCOPE, value) as Partial<Cursor> | undefined;
  if (
    !decoded ||
    Buffer.byteLength(JSON.stringify(decoded), 'utf8') > 2048 ||
    typeof decoded.basis !== 'string' ||
    !/^[a-f0-9]{64}$/.test(decoded.basis) ||
    !Number.isInteger(decoded.segment) ||
    decoded.segment! < 0 ||
    decoded.segment! > 2 ||
    (decoded.after !== null && (typeof decoded.after !== 'string' || routeOf(decoded.after) === null)) ||
    (decoded.pending !== null && (typeof decoded.pending !== 'string' || routeOf(decoded.pending) === null))
  )
    throw new TypeError('Invalid support frontier');
  if (
    decoded.projection !== null &&
    (!decoded.projection ||
      typeof decoded.projection.build !== 'string' ||
      typeof decoded.projection.generation !== 'string' ||
      !/^\d+$/.test(decoded.projection.generation) ||
      typeof decoded.projection.continuation !== 'string')
  )
    throw new TypeError('Invalid projection frontier');
  if (decoded.projection && !decoded.pending) throw new TypeError('Projection frontier has no admitted original');
  return decoded as Cursor;
}

/** Sole Semantic admitted-original bridge. No writer, receiving ACK or publication method. */
export const createIdentitySourceSupportReader: IdentitySourceSupportReaderFactory = (config) => {
  if (
    !config?.pool ||
    !config.access ||
    typeof config.clock !== 'function' ||
    !(config.routeKey instanceof Uint8Array) ||
    config.routeKey.byteLength !== 32
  )
    throw new TypeError('Support requires the installed pool, Access, clock and routeKey');
  // Existing native token primitive and a distinct scope. Payload contains only bounded
  // locators, not support rows, permissions, source facts or an original-ID vector.
  const ring: KeyRing = {
    current: 0,
    keys: new Map([[0, new Uint8Array(config.routeKey)]]),
  };
  const binding = createPublicFilterSourceBinding(config.pool, config.routeKey, config.access);

  // Bind the installed Source instance from the same pool, route key and Access.
  // Its provisional unavailable adapter never becomes an ordinary SubjectSource fallback.
  const nativeSource = publicFilterSource(config);

  async function basis(request: IdentitySourceSupportRequest, charge: (points: number) => void) {
    requireAccessDeadline(request.context.deadline);
    const partition = identityJobPartition(request.job);
    const control = await withReadTransaction(config.pool, async (tx) => {
      charge(1);
      const owner = await readPartition(tx, partition);
      if (!owner || owner.writeState !== 'active') throw new SupportState('unavailable');
      charge(1);
      const job = await identityEpochStore.readJob(tx, request.job);
      if (!job || job.state === 'cancelled' || job.state === 'cancelling' || job.state === 'published')
        throw new SupportState('changed');
      if (job.state !== 'pending' || job.mapping?.state !== 'complete') throw new SupportState('unready');
      charge(1);
      const current = (await tx.query(controlStatement.sql, [partition])).rows[0];
      if (!current) throw new SupportState('unavailable');
      if (current.pending_job !== request.job.jobId || BigInt(current.pending_epoch ?? -1) !== request.job.epoch)
        throw new SupportState('changed');
      const mapping = job.mapping;
      if (
        !sameJob(mapping.job, request.job) ||
        !sameJob(mapping.receipt.job, request.job) ||
        mapping.receipt.step !== 'mapping' ||
        mapping.receipt.version !== 1
      )
        throw new SupportState('unready');
      const inputs = (await tx.query<Input>(inputsStatement.sql, [partition, request.job.jobId])).rows;
      charge(inputs.length);
      if (inputs.length === 0) throw new SupportState('unready');
      return { owner: owner.epoch, job, inputs };
    });
    // Resolve the genuine native mapping step after releasing its control home.
    const native = control.job.mapping!.receipt.native;
    await withReadTransaction(config.pool, async (tx) => {
      charge(1);
      const owner = await readPartition(tx, native.partition);
      if (!owner || owner.writeState !== 'active' || owner.epoch !== native.epoch || owner.position < native.position)
        throw new SupportState('unavailable');
      charge(1);
      const rows = await tx.query(stepStatement.sql, [
        native.partition,
        native.transactionId,
        native.epoch,
        native.position.toString(),
        request.job.jobId,
        request.job.epoch.toString(),
        'mapping',
      ]);
      if (rows.rowCount !== 1 || rows.rows[0]?.state !== 'complete') throw new SupportState('unready');
    });
    for (const input of control.inputs) {
      await withReadTransaction(config.pool, async (tx) => {
        charge(1);
        const owner = await readPartition(tx, input.control_partition);
        if (!owner || owner.writeState !== 'active' || owner.epoch !== input.owner_epoch)
          throw new SupportState('unavailable');
        charge(1);
        const group = (await tx.query(groupsStatement.sql, [input.control_partition, input.terminal])).rows[0];
        if (
          !group ||
          group.pending_job !== request.job.jobId ||
          BigInt(group.pending_epoch ?? -1) !== request.job.epoch ||
          group.generation !== input.generation ||
          group.version !== input.basis_version
        )
          throw new SupportState('changed');
      });
    }
    requireAccessDeadline(request.context.deadline);
    return {
      inputs: control.inputs,
      fingerprint: digest({
        job: [request.job.jobId, request.job.epoch.toString()],
        owner: control.owner,
        inputs: control.inputs,
        definition: request.definition,
        mapping: [native.partition, native.epoch, native.position.toString(), native.transactionId],
      }),
    };
  }

  return {
    async readPage(request) {
      validate(request);
      let cost = zero();
      // Charge each attempted logical owner/job/group/mapping observation, including
      // repeated currentness reads. Native SQL/row/block limits remain independent.
      const charge = (points: number) => {
        cost = add(cost, { ...zero(), dependencyPoints: points });
      };
      const retained = cursor(ring, request.frontier);
      return withRequestDeadline(request.context.deadline, async () => {
        try {
          const start = await basis(request, charge);
          if (retained && retained.basis !== start.fingerprint) return { status: 'changed', cost };
          const resolved = await binding.resolve(
            {
              source: nativeSource,
              meaning: request.definition.meaning,
              capture: request.definition.capture,
            },
            request.context,
          );
          cost = add(cost, resolved.cost);
          if (resolved.status !== 'resolved') return { status: resolved.status, cost };
          if (digest(resolved.definition) !== digest(request.definition)) return { status: 'changed', cost };
          const finish = async () => {
            const end = await basis(request, charge);
            if (end.fingerprint !== start.fingerprint) throw new SupportState('changed');
            const current = await binding.resolve(
              {
                source: nativeSource,
                meaning: request.definition.meaning,
                capture: request.definition.capture,
              },
              request.context,
            );
            cost = add(cost, current.cost);
            if (current.status !== 'resolved') throw new SupportState(current.status);
            if (digest(current.definition) !== digest(request.definition)) throw new SupportState('changed');
            requireAccessDeadline(request.context.deadline);
          };
          const next: Cursor = retained ?? {
            basis: start.fingerprint,
            segment: 0,
            after: null,
            pending: null,
            projection: null,
          };
          const continuation = () => {
            if (Buffer.byteLength(JSON.stringify(next), 'utf8') > 2048) throw new SupportState('unavailable');
            const token = seal(ring, SCOPE, next);
            if (token.length > 4096) throw new SupportState('unavailable');
            return token;
          };
          const progress = () => ({
            status: 'progress' as const,
            records: [],
            frontier: continuation(),
            cost,
          });
          if (!next.pending && next.segment < start.inputs.length) {
            if (cost.inputKeys >= request.inputLimit) return { status: 'unready', cost };
            const input = start.inputs[next.segment]!;
            const rows = await withReadTransaction(config.pool, async (tx) => {
              requireAccessDeadline(request.context.deadline);
              return (
                await tx.query<{ original: string }>(originalsStatement.sql, [
                  input.control_partition,
                  input.generation,
                  input.terminal,
                  next.after,
                  1,
                ])
              ).rows;
            });
            cost = add(cost, { ...zero(), inputKeys: rows.length });
            if (rows.length === 0) {
              next.segment++;
              next.after = null;
            } else next.pending = rows[0]!.original;
          }
          if (!next.pending) {
            await finish();
            if (next.segment === start.inputs.length) return { status: 'complete', records: [], frontier: null, cost };
            return progress();
          }
          // Reserve a separate continuation when the raw original exhausted this step.
          // A one-key caller can still finish a large subject: the next step spends its
          // allowance on projection inputs, without rereading/charging a free original.
          const allowance = request.inputLimit - cost.inputKeys;
          if (allowance <= 0) {
            await finish();
            return progress();
          }
          const original = next.pending;
          charge(1);
          const mapping = await withIdentitySourceSupportJob(request.job, () =>
            identityEpochStore.readMapping(config.pool, original),
          );
          if (mapping.state === 'pending') return { status: 'unready', cost };
          if (mapping.state !== 'mapped') return { status: 'unavailable', cost };
          if (mapping.epoch !== request.job.epoch) return { status: 'changed', cost };
          const projectionFrontier: PublicFilterProjectionFrontier | null = next.projection && {
            ...next.projection,
            generation: BigInt(next.projection.generation),
          };
          const result = await readIdentitySourceProjection(config, nativeSource, {
            job: request.job,
            original,
            terminal: mapping.terminal,
            meaning: request.definition.meaning,
            frontier: projectionFrontier,
            inputLimit: allowance,
            context: request.context,
          });
          cost = add(cost, result.cost);
          if (result.status !== 'projected') return { status: result.status, cost };
          const page = result.projection;
          if (page?.status === 'progress')
            next.projection = {
              ...page.frontier,
              generation: page.frontier.generation.toString(),
            };
          else {
            next.after = original;
            next.pending = null;
            next.projection = null;
          }
          await finish();
          const frontier = continuation();
          return {
            status: 'progress',
            records: [{ original, terminal: mapping.terminal, projection: page }],
            frontier,
            cost,
          };
        } catch (error) {
          if (error instanceof SupportState) return { status: error.status, cost };
          if (classifyUnavailability(error)) return { status: 'unavailable', cost };
          throw error;
        }
      });
    },
  };
};
