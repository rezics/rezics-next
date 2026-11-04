import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { withRequestDeadline } from '../request/deadline.ts';
import { routeOf } from '../route/route.ts';
import { classifyUnavailability } from '../access/unavailable.ts';
import { withReadTransaction } from './read.ts';
import { identityJobPartition, serializeIdentityValue as json } from './identity-adapters/index.ts';
import jobSQL from './identity-epoch-prearm-custody-job.sql';
import directorySQL from './identity-epoch-prearm-custody-directory.sql';
import pagesSQL from './identity-epoch-prearm-custody-pages.sql';
import inputsSQL from './identity-epoch-prearm-custody-inputs.sql';
import type { IdentityFrontier, IdentityIntent, IdentityJobRef, NativeStepWork } from './identity-epoch-contract.ts';
import type { IdentityPrearmTicketData } from './identity-epoch-prearm-contract.ts';
import type { IdentitySourceConsumerMaintenanceWork } from './identity-source-consumer-maintenance.ts';
import {
  isLiveIdentitySourceConsumerMaintenance,
  reserveIdentitySourceConsumerNativeWork,
} from './identity-source-consumer-maintenance.ts';

export type IdentityPrearmCustodyRequest = Readonly<{
  job: IdentityJobRef;
  after: IdentityFrontier | null;
  limit: number;
  allowance: NativeStepWork;
}>;
export type IdentityPrearmCustodyContext = Readonly<{
  deadline: number;
  identityConsumerWork?: IdentitySourceConsumerMaintenanceWork;
}>;
declare const custodyCut: unique symbol;
/** Only the exact retained admitted native input directory; no consumer completion authority. */
export type IdentityPrearmCustodyCut = Readonly<{ [custodyCut]: true }>;
export type IdentityPrearmCustodyPage =
  | Readonly<{
      status: 'progress';
      tickets: readonly IdentityPrearmTicketData[];
      frontier: IdentityFrontier;
      work: NativeStepWork;
    }>
  | Readonly<{
      status: 'complete';
      tickets: readonly IdentityPrearmTicketData[];
      frontier: IdentityFrontier;
      cut: IdentityPrearmCustodyCut;
      work: NativeStepWork;
    }>
  | Readonly<{ status: 'unavailable'; reason: string; work: NativeStepWork }>;
export type IdentityPrearmCustodyVerification = Readonly<{
  status: 'current' | 'unavailable';
  work: NativeStepWork;
}>;

// In-process authentication protects the bounded scalar continuation, not native truth.
// Every call still resolves the original records and each current owner, in released reads.
const continuationKey = randomBytes(32);
const cuts = new WeakMap<
  IdentityPrearmCustodyCut,
  Readonly<{
    job: IdentityJobRef;
    frontier: IdentityFrontier;
    allowance: NativeStepWork;
  }>
>();
const keys = ['rows', 'points', 'statements', 'bytes', 'engineRequests'] as const;
type Work = { -readonly [K in keyof NativeStepWork]: NativeStepWork[K] };
const emptyWork = (): Work => ({ rows: 0, points: 0, statements: 0, bytes: 0, engineRequests: 0 });
class Unavailable extends Error {}
const refuse = (reason: string): never => {
  throw new Unavailable(reason);
};
const stamp = (value: unknown) => createHash('sha256').update(json(value)).digest('hex');
const sameJob = (a: IdentityJobRef, b: IdentityJobRef) => a.jobId === b.jobId && a.epoch === b.epoch;
const validJob = (job: IdentityJobRef) =>
  routeOf(job.jobId) !== null && typeof job.epoch === 'bigint' && job.epoch > 0n && job.epoch <= 9223372036854775807n;
const validAllowance = (allowance: NativeStepWork) =>
  keys.every((key) => Number.isSafeInteger(allowance[key]) && allowance[key] >= 0);

type Root = QueryResultRow & {
  scope_digest: string;
  state: string;
  recorded_transaction_id: string;
  intent: IdentityIntent;
};
type OriginalInput = QueryResultRow & {
  original: string;
  terminal: string;
  generation: string;
  basis_version: string;
  control_partition: number;
  owner_epoch: number;
  valid: boolean;
};
type Input = QueryResultRow & {
  terminal: string;
  generation: string;
  basis_version: string;
  control_partition: number;
  owner_epoch: number;
  prearm_sequence: string;
  prearm_transaction_id: string;
  prearm_epoch: number;
  prearm_position: string;
  prearm_cancelled_transaction_id: string | null;
};
type Directory = QueryResultRow & {
  partition_no: number;
  generation: string;
  sequence: string;
  sealed_transaction_id: string;
  seal_epoch: number;
  seal_position: string;
  attempt_transaction_id: string;
  attempt_epoch: number;
  attempt_position: string;
  release_epoch: number;
  release_position: string;
  cancelled_transaction_id: string | null;
};
type Page = QueryResultRow & {
  sequence: string;
  page_id: string;
  original: string | null;
  valid: boolean;
  scope: IdentityPrearmTicketData['scope'];
  registration: string;
  capture_id: string;
  transaction_id: string;
  export_epoch: number;
  export_position: string;
};
type Inventory = { root: Root; inputs: Input[]; rootStamp: string };
type Position = { segment: number; sequence: bigint; root: string; directories: readonly (string | null)[] };

function authenticate(job: IdentityJobRef, segment: number, after: readonly (string | number | null)[]) {
  return createHmac('sha256', continuationKey)
    .update(json([job, segment, after]))
    .digest('hex');
}
function frontier(job: IdentityJobRef, position: Position): IdentityFrontier {
  const after = [position.sequence.toString(), position.root, ...position.directories];
  return Object.freeze({
    segment: position.segment,
    after: Object.freeze([...after, authenticate(job, position.segment, after)]),
  });
}
function decode(job: IdentityJobRef, value: IdentityFrontier, homes: number): Position {
  if (
    !Number.isSafeInteger(value.segment) ||
    value.segment < 0 ||
    value.segment > homes ||
    value.after.length !== 5 ||
    Buffer.byteLength(json(value)) > 2048
  )
    return refuse('invalid-frontier');
  const [sequence, root, first, second, mac] = value.after;
  if (
    typeof sequence !== 'string' ||
    !/^(0|[1-9][0-9]{0,18})$/.test(sequence) ||
    typeof root !== 'string' ||
    typeof first !== 'string' ||
    (homes === 2 ? typeof second !== 'string' : second !== null) ||
    mac !== authenticate(job, value.segment, value.after.slice(0, -1))
  )
    return refuse('invalid-frontier');
  if (value.segment === homes && sequence !== '0') return refuse('invalid-frontier');
  return { segment: value.segment, sequence: BigInt(sequence), root, directories: [first, second as string | null] };
}

class ReadWork {
  readonly work = emptyWork();
  readonly deadline: number;
  private parentBytesReserved = false;
  constructor(
    readonly pool: Pool,
    readonly allowance: NativeStepWork,
    context: IdentityPrearmCustodyContext,
    private readonly consumerWork?: IdentitySourceConsumerMaintenanceWork,
  ) {
    this.deadline = Math.min(context.deadline, Date.now() + 5000);
  }
  current() {
    if (!Number.isFinite(this.deadline) || Date.now() >= this.deadline) refuse('deadline');
    if (this.work.rows > 100 || keys.some((key) => this.work[key] > this.allowance[key]))
      refuse('native-work-allowance');
  }
  reserveParentBytes() {
    if (this.parentBytesReserved || !this.consumerWork) return;
    if (
      !reserveIdentitySourceConsumerNativeWork(this.pool, this.consumerWork, {
        rows: 0,
        points: 0,
        statements: 0,
        bytes: this.allowance.bytes,
        engineRequests: 0,
      })
    )
      return refuse('source-maintenance-work-allowance');
    this.parentBytesReserved = true;
  }
  charge(rows: number, points: number, statements: number, bytes: number) {
    this.current();
    if (
      this.work.rows + rows > Math.min(100, this.allowance.rows) ||
      this.work.points + points > this.allowance.points ||
      this.work.statements + statements > this.allowance.statements ||
      this.work.bytes + bytes > this.allowance.bytes
    )
      refuse('native-work-allowance');
    if (
      this.consumerWork &&
      !reserveIdentitySourceConsumerNativeWork(this.pool, this.consumerWork, {
        rows,
        points,
        statements,
        bytes: 0,
        engineRequests: 0,
      })
    )
      return refuse('source-maintenance-work-allowance');
    this.work.rows += rows;
    this.work.points += points;
    this.work.statements += statements;
    this.work.bytes += bytes;
  }
  async snapshot<T>(pool: Pool, read: (tx: PoolClient) => Promise<T>): Promise<T> {
    // Reserve BEGIN, timeout, COMMIT and possible ROLLBACK, including failed checkout work.
    const frameworkBytes =
      Buffer.byteLength('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY') +
      Buffer.byteLength("SET LOCAL statement_timeout = '5000ms'") +
      Buffer.byteLength('COMMITROLLBACK');
    this.charge(0, 0, 4, frameworkBytes);
    return withReadTransaction(pool, read);
  }
  async query<T extends QueryResultRow>(tx: PoolClient, sql: string, values: unknown[], touches: number): Promise<T[]> {
    // Fixed exact-key probes include every native metadata row and failed/rejected point.
    // Page probes reserve all joined raw keys, including empty/lookahead work, before SQL.
    this.charge(touches, touches, 1, Buffer.byteLength(sql) + Buffer.byteLength(json(values)));
    const rows = (await tx.query<T>(sql, values)).rows;
    this.work.bytes += Buffer.byteLength(json(rows));
    this.current();
    return rows;
  }
}

async function inventory(pool: Pool, job: IdentityJobRef, work: ReadWork): Promise<Inventory> {
  // The complete child byte ceiling is held against Source before any result can be read;
  // actual result bytes remain checked against this same bounded child allowance.
  work.reserveParentBytes();
  return work.snapshot(pool, async (tx) => {
    const root = (
      await work.query<Root>(tx, jobSQL.sql, [identityJobPartition(job), job.jobId, job.epoch.toString()], 9)
    )[0];
    if (!root) return refuse('original-job-or-terminal-custody-unavailable');
    const sources = await work.query<OriginalInput>(
      tx,
      inputsSQL.sql,
      [identityJobPartition(job), job.jobId, root.recorded_transaction_id],
      4,
    );
    const originals =
      root.intent.kind === 'merge'
        ? [root.intent.redirected, root.intent.survivor]
        : root.intent.kind === 'repoint'
          ? [root.intent.original, root.intent.terminal]
          : root.intent.kind === 'unmerge'
            ? [root.intent.original]
            : [];
    if (
      !originals.length ||
      sources.some((source) => !source.valid) ||
      sources.length !== new Set(originals).size ||
      originals.some((id) => !sources.some((source) => source.original === id))
    )
      return refuse('original-input-provenance-unavailable');
    // Native intents have at most two immutable input generations. The third row is a rejection probe.
    const inputs = await work.query<Input>(
      tx,
      `SELECT terminal,generation,basis_version,original_count,
      control_partition,owner_epoch,prearm_sequence,prearm_transaction_id,prearm_epoch,prearm_position,
      prearm_cancelled_transaction_id FROM semantic.identity_epoch_input
      WHERE partition_no=$1 AND job_id=$2 ORDER BY terminal LIMIT 3`,
      [identityJobPartition(job), job.jobId],
      3,
    );
    if (
      !inputs.length ||
      inputs.length > 2 ||
      inputs.some(
        (i) =>
          !i.prearm_transaction_id ||
          i.owner_epoch === null ||
          (root.state !== 'published' && !i.prearm_cancelled_transaction_id),
      )
    )
      return refuse('immutable-input-coverage-unavailable');
    const sameInput = (source: OriginalInput, input: Input) =>
      source.terminal === input.terminal &&
      source.generation === input.generation &&
      source.basis_version === input.basis_version &&
      source.control_partition === input.control_partition &&
      source.owner_epoch === input.owner_epoch;
    if (
      inputs.length !== new Set(sources.map((source) => source.terminal)).size ||
      sources.some((source) => !inputs.some((input) => sameInput(source, input))) ||
      inputs.some((input) => !sources.some((source) => sameInput(source, input)))
    )
      return refuse('immutable-input-coverage-unavailable');
    return { root, inputs, rootStamp: stamp([root, sources, inputs]) };
  });
}

async function directory(tx: PoolClient, job: IdentityJobRef, input: Input, root: Root, work: ReadWork) {
  const d = (
    await work.query<Directory>(
      tx,
      directorySQL.sql,
      [
        input.control_partition,
        job.jobId,
        job.epoch.toString(),
        input.generation,
        input.terminal,
        input.basis_version,
        input.owner_epoch,
        root.scope_digest,
        root.state,
        identityJobPartition(job),
        root.recorded_transaction_id,
      ],
      14,
    )
  )[0];
  if (
    !d ||
    d.sequence !== input.prearm_sequence ||
    d.sealed_transaction_id !== input.prearm_transaction_id ||
    d.seal_epoch !== input.prearm_epoch ||
    d.seal_position !== input.prearm_position ||
    (root.state !== 'published' && d.cancelled_transaction_id !== input.prearm_cancelled_transaction_id)
  )
    return refuse('retained-directory-release-or-final-fence-unavailable');
  return d;
}

/** Exhaust only the original native admitted directory. This never calls admission or Source writers. */
export async function readIdentityPrearmCustodyPage(
  pool: Pool,
  request: IdentityPrearmCustodyRequest,
  context: IdentityPrearmCustodyContext,
): Promise<IdentityPrearmCustodyPage> {
  // Snapshot caller-owned locators before the first await. Authentication cannot authorize
  // a later mutation of the job, work allowance or scalar continuation.
  request = { ...request, job: { ...request.job }, allowance: { ...request.allowance } };
  if (
    context.identityConsumerWork &&
    !isLiveIdentitySourceConsumerMaintenance(pool, context.identityConsumerWork, context.deadline)
  )
    return { status: 'unavailable', reason: 'source-maintenance-work-unavailable', work: emptyWork() };
  const work = new ReadWork(pool, request.allowance, context, context.identityConsumerWork);
  if (request.after && (request.after.after.length > 8 || Buffer.byteLength(json(request.after)) > 2048))
    return { status: 'unavailable', reason: 'invalid-frontier', work: work.work };
  request = {
    ...request,
    after: request.after ? { segment: request.after.segment, after: [...request.after.after] } : null,
  };
  if (
    !validJob(request.job) ||
    !validAllowance(request.allowance) ||
    !Number.isInteger(request.limit) ||
    request.limit < 1 ||
    request.limit > 100
  )
    return { status: 'unavailable', reason: 'invalid-request', work: work.work };
  return withRequestDeadline(work.deadline, async () => {
    try {
      const { root, inputs, rootStamp } = await inventory(pool, request.job, work);
      const saved = request.after ? decode(request.job, request.after, inputs.length) : null;
      if (saved && saved.root !== rootStamp) return refuse('original-job-or-input-changed');
      if (saved?.segment === inputs.length) return refuse('already-exhausted-frontier');
      const segment = saved?.segment ?? 0;
      const sequence = saved?.sequence ?? 0n;
      const directories: (string | null)[] = [null, null];
      const tickets: IdentityPrearmTicketData[] = [];
      let nextSegment = segment,
        nextSequence = sequence;
      // Each home is released before another checkout. Never hold a job client across this loop.
      for (let index = 0; index < inputs.length; index++) {
        const input = inputs[index]!;
        await work.snapshot(pool, async (tx) => {
          const d = await directory(tx, request.job, input, root, work);
          directories[index] = stamp(d);
          if (saved && saved.directories[index] !== directories[index]) return refuse('native-directory-fence-changed');
          if (index !== segment) return;
          if (sequence >= BigInt(d.sequence)) return refuse('invalid-directory-position');
          // Reserve the remaining homes' metadata and framework work before choosing a raw page.
          const later = inputs.length - index - 1;
          const remaining = Math.min(100, request.allowance.rows) - work.work.rows - later * 14;
          const points = request.allowance.points - work.work.points - later * 14;
          const count = Math.min(request.limit, Math.floor(Math.min(remaining, points) / 5));
          if (count < 1) return refuse('native-work-allowance');
          const pages = await work.query<Page>(
            tx,
            pagesSQL.sql,
            [
              input.control_partition,
              request.job.jobId,
              input.generation,
              sequence.toString(),
              d.release_epoch,
              d.release_position,
              count,
            ],
            count * 5,
          );
          if (!pages.length) return refuse('missing-native-page');
          for (const page of pages) {
            if (
              !page.valid ||
              BigInt(page.sequence) !== nextSequence + 1n ||
              BigInt(page.sequence) > BigInt(d.sequence)
            )
              return refuse('native-page-custody-unavailable');
            nextSequence = BigInt(page.sequence);
            if (page.original === null) {
              if (page.sequence !== d.sequence) return refuse('premature-empty-page');
              nextSegment = segment + 1;
              nextSequence = 0n;
              if (page !== pages[pages.length - 1]) return refuse('page-beyond-final-fence');
            } else {
              tickets.push({
                locator: {
                  job: { ...request.job },
                  pageId: page.page_id,
                  ordinal: 0,
                  directory: {
                    partition: input.control_partition,
                    epoch: page.export_epoch,
                    position: BigInt(page.export_position),
                    transactionId: page.transaction_id,
                  },
                },
                scope: page.scope,
                registration: page.registration,
                captureId: page.capture_id,
                attempt: {
                  partition: input.control_partition,
                  epoch: d.attempt_epoch,
                  position: BigInt(d.attempt_position),
                  transactionId: d.attempt_transaction_id,
                },
              });
            }
          }
        });
      }
      work.current();
      const next = frontier(request.job, {
        segment: nextSegment,
        sequence: nextSequence,
        root: rootStamp,
        directories,
      });
      if (nextSegment !== inputs.length) return { status: 'progress', tickets, frontier: next, work: work.work };
      const cut = Object.freeze({}) as IdentityPrearmCustodyCut;
      cuts.set(cut, {
        job: Object.freeze({ ...request.job }),
        frontier: next,
        allowance: Object.freeze({ ...request.allowance }),
      });
      return { status: 'complete', tickets, frontier: next, cut, work: work.work };
    } catch (error) {
      const reason = error instanceof Unavailable ? error.message : classifyUnavailability(error);
      if (!reason) throw error;
      return { status: 'unavailable', reason, work: work.work };
    }
  });
}

/** Native rereads, not brand equality: original job/inputs, current owners, retained page/final/release fences. */
export async function verifyIdentityPrearmCustodyCut(
  pool: Pool,
  job: IdentityJobRef,
  cut: IdentityPrearmCustodyCut,
  context: IdentityPrearmCustodyContext,
): Promise<IdentityPrearmCustodyVerification> {
  job = { ...job };
  const saved = cuts.get(cut);
  if (!saved || !validJob(job) || !sameJob(job, saved.job)) return { status: 'unavailable', work: emptyWork() };
  if (
    context.identityConsumerWork &&
    !isLiveIdentitySourceConsumerMaintenance(pool, context.identityConsumerWork, context.deadline)
  )
    return { status: 'unavailable', work: emptyWork() };
  const work = new ReadWork(pool, saved.allowance, context, context.identityConsumerWork);
  return withRequestDeadline(work.deadline, async () => {
    try {
      const { root, inputs, rootStamp } = await inventory(pool, job, work);
      const position = decode(job, saved.frontier, inputs.length);
      if (position.segment !== inputs.length || position.root !== rootStamp)
        return refuse('original-job-or-input-changed');
      for (let index = 0; index < inputs.length; index++) {
        const d = await work.snapshot(pool, (tx) => directory(tx, job, inputs[index]!, root, work));
        if (stamp(d) !== position.directories[index]) return refuse('native-directory-fence-changed');
      }
      work.current();
      return { status: 'current', work: work.work };
    } catch (error) {
      if (!(error instanceof Unavailable) && !classifyUnavailability(error)) throw error;
      return { status: 'unavailable', work: work.work };
    }
  });
}
