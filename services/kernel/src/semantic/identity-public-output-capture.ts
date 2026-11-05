import prearmCancelledSQL from './identity-public-output-prearm-cancelled.sql';
import prearmReceiptSQL from './identity-public-output-prearm-receipt.sql';
import prearmReceiptInsertSQL from './identity-public-output-prearm-receipt-insert.sql';
import prearmAttemptInsertSQL from './identity-public-output-prearm-attempt-insert.sql';
import prearmUnsafeSQL from './identity-public-output-prearm-unsafe.sql';
import prearmAttemptSQL from './identity-public-output-prearm-attempt.sql';
import { createHash, randomUUID } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import {
  currentCommand,
  currentCommandResources,
  registerCommandCallback,
  runCommand,
  withSingleCommandAttempt,
  type CommandTransaction,
} from '../command/command.ts';
import type {
  NativePublicOutputBinding,
  PublicOutputCommandContext,
  PublicOutputDispositionSelection,
  LockPublicOutputDisposition,
  LockedPublicOutputDisposition,
} from '../library/native-public-output-contract.ts';
const native = () => import('../library/collection-source-native.ts');
import type { CanonicalRangeKey } from '../library/collection-source-native.ts';
import type { PublicFilterSourceFactory } from './public-filter-source-contract.ts';
import { createPublicFilterSourceBinding, type PublicFilterSourceDefinition } from './public-filter-source-binding.ts';
import { publicFilterSource } from './public-filter-source.ts';
import { NativeCollectionWork, instrumentNativeCollectionWork } from '../library/collection-source-work.ts';
import type { WorkAllowance } from '../library/collection-source.ts';
import type { IdentityNativeReceipt } from './identity-epoch-contract.ts';
import { recordIdentityEpochNativeCommit } from './identity-adapters/index.ts';
import { readIdentityMappings } from './identity-adapters/identity-epoch-read.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { identityScopeAddress } from './identity-scoped-observations.ts';
import { withReadTransaction } from './read.ts';
import { withRequestDeadline } from '../request/deadline.ts';
import type { IdentityScopeKey } from './identity-scope-types.ts';
import type * as T from './identity-public-output-types.ts';
import { outputCaptureFootprint } from './identity-public-output-work.ts';
import acceptedSQL from './identity-public-output-accepted.sql';
import existingSQL from './identity-public-output-existing.sql';
import dispositionLocatorSQL from './identity-public-output-disposition-locator.sql';
import insertSQL from './identity-public-output-insert.sql';
import progressSQL from './identity-public-output-progress.sql';
import startSQL from './identity-public-output-progress-start.sql';
import componentSQL from './identity-public-output-component.sql';
import planSQL from './identity-public-output-plan.sql';
import pageSQL from './identity-public-output-page.sql';
import originalsSQL from './identity-public-output-original.sql';
import advanceSQL from './identity-public-output-advance.sql';
import scopeStartSQL from './identity-public-output-scope-start.sql';
import scopeSQL from './identity-public-output-scope.sql';
import scopeSealSQL from './identity-public-output-scope-seal.sql';
import sealSQL from './identity-public-output-seal.sql';
import sealInsertSQL from './identity-public-output-seal-insert.sql';
import fenceSQL from './identity-public-output-fence.sql';
import fenceInsertSQL from './identity-public-output-fence-insert.sql';
import prefixSQL from './identity-public-output-prefix.sql';
import membershipSQL from './identity-public-output-membership.sql';
import definitionSizeSQL from './identity-public-output-definition-size.sql';
import mappingSQL from './identity-public-output-mapping.sql';
import cutGroupSQL from './identity-public-output-cut-group.sql';
import cutGroupReadSQL from './identity-public-output-cut-group-read.sql';
import slotSQL from './identity-public-output-cut-slot.sql';
import slotLockSQL from './identity-public-output-cut-slot-lock.sql';
import bridgeSQL from './identity-public-output-cut-bridge.sql';
import bridgeLockSQL from './identity-public-output-cut-bridge-lock.sql';
import cutMemberSQL from './identity-public-output-cut-member.sql';
import cutInsertSQL from './identity-public-output-cut-insert.sql';
import cutSQL from './identity-public-output-cut.sql';
import cutReleaseSQL from './identity-public-output-cut-release.sql';
import cutReleasedSQL from './identity-public-output-cut-released.sql';
import cutLiveSQL from './identity-public-output-cut-live.sql';
import settingSQL from './identity-public-output-release-setting.sql';
import dispositionSQL from './identity-public-output-disposition.sql';
import dispositionInsertSQL from './identity-public-output-disposition-insert.sql';
import transitionSQL from './identity-public-output-transition.sql';
import admissionsSQL from './identity-public-output-admissions.sql';
import consumerSQL from './identity-public-output-consumer.sql';
import plansSQL from './identity-public-output-plans.sql';
import closeProgressSQL from './identity-public-output-close-progress.sql';
import gateStartSQL from './identity-public-output-gate-start.sql';
import gateCloseSQL from './identity-public-output-gate-close.sql';
import gateSQL from './identity-public-output-gate.sql';
import stageSQL from './identity-public-output-stage.sql';

const PURPOSE = 'identity-public-output-capture';
const EVENT = 'com.rezics.semantic.public-output.capture.v1';
const stringify = (value: unknown): string =>
  JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
const hash = (value: unknown): string =>
  createHash('sha256')
    .update(canonicalize(JSON.parse(stringify(value)))!)
    .digest('hex');
const equal = (a: unknown, b: unknown): boolean => hash(a) === hash(b);
function bounded<T>(value: T, bytes: number): T {
  if (Buffer.byteLength(stringify(value)) > bytes)
    throw new RangeError('Public output retained body exceeds its admitted bound');
  return value;
}
function id(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value))
    throw new TypeError('Expected canonical capture UUID');
}
class Refusal extends Error {
  constructor(
    readonly reason: T.PublicIdentityOutputRefusal['reason'],
    readonly status: 'changed' | 'unavailable' = 'unavailable',
    readonly dependency?: string,
  ) {
    super(`public_output_capture_${reason}`);
  }
}
const refuse = (
  reason: T.PublicIdentityOutputRefusal['reason'],
  status: 'changed' | 'unavailable' = 'unavailable',
  dependency?: string,
): never => {
  throw new Refusal(reason, status, dependency);
};
type Accepted = {
  capture_id: string;
  binding: NativePublicOutputBinding;
  definition: PublicFilterSourceDefinition;
  scope_key: string;
  reservation_id: string;
  native_epoch: number;
  native_position: string;
  transaction_id: string;
};
type Cut = { home: number; original: string; terminal: string; generation: string; epoch: string };
type Mapping = { original: string; terminal: string; epoch: string };
type Plan = {
  before: CanonicalRangeKey | null;
  after: CanonicalRangeKey | null;
  exhausted: boolean;
  rows: readonly CanonicalRangeKey[];
  mappings: Mapping[];
  cuts: Cut[];
};
type Progress = {
  version: string;
  after_key: CanonicalRangeKey | null;
  exhausted: boolean;
  manifest_digest: string;
  raw_count: string;
  canonical_count: string;
  pending: Plan | null;
  closure_after: string;
};
type Seal = {
  manifest_digest: string;
  version: string;
  raw_count: string;
  canonical_count: string;
  native_epoch: number;
  native_position: string;
  transaction_id: string;
};
type Disposition = {
  kind: 'applied' | 'cancelled';
  manifest_digest: string | null;
  seal_transaction_id: string | null;
  native_epoch: number;
  native_position: string;
  transaction_id: string;
  successor_hold_id: string | null;
  cancellation_epoch: string | null;
  purpose: 'identity-public-output-applied' | 'identity-public-output-cancelled';
  staged: boolean;
};
type Gate = {
  state: 'open' | 'applied' | 'cancelled';
  original_epoch: string;
  receiving_epoch: string;
  enrolled_count: string;
};
async function gate(tx: CommandTransaction, a: Accepted): Promise<Gate> {
  const row = await one<Gate>(tx, gateSQL, [
    a.binding.accepted.partition,
    a.capture_id,
    currentCommand(tx).transactionId,
  ]);
  if (!row || row.original_epoch !== a.binding.tuple.identity.receivingEpoch) return refuse('provenance');
  return row;
}
async function noForeignReceivers(tx: CommandTransaction, a: Accepted): Promise<Gate> {
  const row = await gate(tx, a);
  // This positive monotone admission counter is protected by a persisted enrollment fence.
  // An empty consumer query is only a consistency check, never the source of closure authority.
  if (row.enrolled_count !== '0' || (await one(tx, admissionsSQL, [a.binding.accepted.partition, a.capture_id])))
    return refuse('foreign_closure_missing', 'unavailable', 'search.public-output.enrolled-receiver-writer-closure');
  return row;
}
const receipt = (
  partition: number,
  row: { native_epoch: number; native_position: string; transaction_id: string },
): IdentityNativeReceipt => ({
  partition,
  epoch: row.native_epoch,
  position: BigInt(row.native_position),
  transactionId: row.transaction_id,
});
async function one<R extends QueryResultRow>(
  tx: CommandTransaction,
  sql: { sql: string },
  values: unknown[],
): Promise<R | undefined> {
  return (await tx.query<R>(sql.sql, values)).rows[0];
}
function locator(a: Accepted): T.PublicIdentityOutputCapture {
  return {
    kind: 'public-output',
    partition: a.binding.accepted.partition,
    captureId: a.capture_id,
    bindingDigest: a.binding.bindingDigest,
  };
}
function scope(a: Accepted) {
  return { source: { kind: 'library' as const, identity: a.binding.tuple.identity }, scopeId: a.capture_id };
}
function coherentPublication(binding: NativePublicOutputBinding): boolean {
  const { identity, publication } = binding.tuple;
  return (
    identity.scope === 'public_output' &&
    identity.ownerEpoch === binding.accepted.epoch &&
    identity.outputGeneration === publication.generation &&
    equal(identity.activation, {
      transactionId: publication.transactionId,
      position: publication.position,
      sourceGeneration: publication.sourceGeneration,
    })
  );
}
function context(
  tx: CommandTransaction,
  pool: Pool,
  deadline: number,
  allowance: WorkAllowance,
): PublicOutputCommandContext {
  return { pool, at: currentCommand(tx).time, deadline, allowance };
}
async function component(tx: CommandTransaction, purpose = PURPOSE): Promise<IdentityNativeReceipt> {
  const c = currentCommand(tx);
  const p = await one<{ epoch: number; position: string }>(tx, componentSQL, [c.partition]);
  if (!p) return refuse('provenance');
  recordIdentityEpochNativeCommit(tx, purpose);
  return { partition: c.partition, epoch: p.epoch, position: BigInt(p.position), transactionId: c.transactionId };
}
async function load(tx: CommandTransaction, l: T.PublicIdentityOutputCapture): Promise<Accepted> {
  id(l.captureId);
  const a = await one<Accepted>(tx, acceptedSQL, [l.partition, l.captureId]);
  if (!a || a.binding.bindingDigest !== l.bindingDigest) return refuse('provenance');
  a.binding = {
    ...a.binding,
    accepted: { ...a.binding.accepted, position: BigInt(a.binding.accepted.position) },
    tuple: {
      ...a.binding.tuple,
      observation: { ...a.binding.tuple.observation, position: BigInt(a.binding.tuple.observation.position) },
    },
  };
  if (
    !equal(a.binding.accepted, receipt(l.partition, a)) ||
    a.binding.captureId !== l.captureId ||
    partitionOf(a.binding.tuple.identity.route) !== l.partition ||
    !coherentPublication(a.binding) ||
    a.binding.definitionDigest !== hash(a.definition)
  )
    return refuse('binding');
  return a;
}
async function eligible(
  tx: CommandTransaction,
  a: Accepted,
  work: NativeCollectionWork,
  deadline: number,
): Promise<void> {
  const l = locator(a),
    pool = currentCommandResources(tx).pool;
  if (currentCommand(tx).partition !== l.partition) return refuse('provenance');
  const s = await one<{ revision: string; active: number; state: string; registration: string; capture_id: string }>(
    tx,
    scopeSQL,
    [l.partition, a.scope_key, l.captureId],
  );
  if (
    !s ||
    s.revision !== '1' ||
    s.active !== 0 ||
    !['capturing', 'ready'].includes(s.state) ||
    s.registration !== a.binding.holdId ||
    s.capture_id !== l.captureId
  )
    return refuse('closure', 'changed');
  if (await one(tx, fenceSQL, [l.partition, l.captureId])) return refuse('fenced', 'changed');
  const held = await work.compose(async (allowance) =>
    (await native()).revalidateNativePublicCollectionOutputHold(tx, a.binding, context(tx, pool, deadline, allowance)),
  );
  if (held.status !== 'locked' || !equal(held.binding, a.binding)) return refuse('current', 'changed');
  const current = await work.compose(async (allowance) =>
    (await native()).lockNativePublicCollectionOutput(
      tx,
      a.binding.tuple.identity,
      context(tx, pool, deadline, allowance),
    ),
  );
  if (current.status !== 'locked' || !samePublication(current.tuple, a.binding.tuple))
    return refuse('current', 'changed');
}

// Observation is the current snapshot position. It advances without changing the immutable output.
function samePublication(a: NativePublicOutputBinding['tuple'], b: NativePublicOutputBinding['tuple']) {
  return equal(a.identity, b.identity) && equal(a.publication, b.publication);
}

/** Every call owns one finite frame. Command retries are surrendered; continuation is persisted. */
export function createPublicIdentityOutputCapture(config: Parameters<PublicFilterSourceFactory>[0]) {
  const { pool } = config;
  const binding = createPublicFilterSourceBinding(pool, config.routeKey, config.access);
  const source = publicFilterSource(config);
  async function execute<R extends object>(
    options: T.PublicIdentityOutputWork,
    body: (work: NativeCollectionWork) => Promise<R>,
  ): Promise<T.PublicIdentityOutputResult<R>> {
    const work = new NativeCollectionWork(options.allowance, options.deadline);
    try {
      const result = await instrumentNativeCollectionWork(
        pool,
        work,
        (sql, values) => outputCaptureFootprint(work, sql, values),
        () => withRequestDeadline(options.deadline, () => body(work)),
      );
      return { ...result, work: work.receipt() };
    } catch (error) {
      if (error instanceof Refusal)
        return {
          status: error.status,
          reason: error.reason,
          ...(error.dependency ? { dependency: error.dependency } : {}),
          work: work.receipt(),
        };
      if (error instanceof Error)
        Object.defineProperty(error, 'work', { get: () => work.receipt(), configurable: true });
      throw error;
    }
  }
  async function command<R>(
    home: number,
    deadline: number,
    captureId: string,
    body: (tx: CommandTransaction) => Promise<R>,
  ): Promise<R> {
    return (
      await withSingleCommandAttempt(() =>
        runCommand(pool, { partition: home, deadline }, async (tx) => ({
          value: await body(tx),
          events: [{ type: EVENT, data: { captureId } }],
        })),
      )
    ).value;
  }
  async function read<R>(deadline: number, body: (tx: CommandTransaction) => Promise<R>): Promise<R> {
    return withReadTransaction(pool, body, deadline);
  }
  async function resolveDefinition(
    definition: PublicFilterSourceDefinition,
    work: NativeCollectionWork,
    deadline: number,
  ): Promise<void> {
    bounded(definition, 2097152);
    // Admit the actual immutable release/read-definition projection before the resolver can dispatch it.
    const size = await read(deadline, (tx) =>
      one<{ definition_bytes: number; release_bytes: number }>(tx, definitionSizeSQL, [
        definition.source.partition,
        definition.readDefinition,
      ]),
    );
    if (!size) return refuse('binding');
    work.admitResultBytes('public-output-definition', Number(size.definition_bytes));
    work.admitResultBytes('public-output-release', Number(size.release_bytes));
    const resolved = await binding.resolve(
      { source, meaning: definition.meaning, capture: definition.capture },
      { deadline },
    );
    if (resolved.status !== 'resolved' || !equal(resolved.definition, definition)) return refuse('binding', 'changed');
  }
  async function captureAcceptance(request: T.PublicIdentityOutputAcceptance, options: T.PublicIdentityOutputWork) {
    // Snapshot all input before any asynchronous release. Never accept an identity/effect from a caller.
    const r = structuredClone(request);
    id(r.captureId);
    bounded(r, 2105344);
    if (routeOf(r.publication.collectionId) !== r.publication.route) throw new TypeError('Invalid Collection route');
    const home = partitionOf(r.publication.route);
    return execute(options, async (work) => {
      // Resolve an original committed binding before any fresh definition/eligibility admission.
      const known = await read(options.deadline, (tx) => one(tx, acceptedSQL, [home, r.captureId]));
      if (!known) await resolveDefinition(r.definition, work, options.deadline);
      return command(home, options.deadline, r.captureId, async (tx) => {
        const prior = await one<Accepted>(tx, acceptedSQL, [home, r.captureId]);
        if (prior) {
          const a = await load(tx, {
            kind: 'public-output',
            partition: home,
            captureId: r.captureId,
            bindingDigest: prior.binding.bindingDigest,
          });
          const i = a.binding.tuple.identity;
          if (
            !equal(a.definition, r.definition) ||
            !equal(
              {
                route: i.route,
                collectionId: i.collectionId,
                generation: i.outputGeneration,
                activation: i.activation,
              },
              r.publication,
            )
          )
            return refuse('binding', 'changed');
          await eligible(tx, a, work, options.deadline);
          await component(tx);
          return { status: 'accepted' as const, capture: locator(a) };
        }
        if (await one(tx, existingSQL, [home, r.captureId])) return refuse('provenance');
        const accepted = await component(tx);
        const result = await work.compose(async (allowance) =>
          (await native()).bindAndHoldNativePublicCollectionOutput(
            tx,
            { captureId: r.captureId, definitionDigest: hash(r.definition), publication: r.publication },
            context(tx, pool, options.deadline, allowance),
          ),
        );
        if (result.status !== 'bound') return refuse('current', result.status);
        const b = bounded(result.binding, 16384);
        if (
          !equal(b.accepted, accepted) ||
          b.captureId !== r.captureId ||
          b.definitionDigest !== hash(r.definition) ||
          !coherentPublication(b) ||
          !equal(
            {
              route: b.tuple.identity.route,
              collectionId: b.tuple.identity.collectionId,
              generation: b.tuple.identity.outputGeneration,
              activation: b.tuple.identity.activation,
            },
            r.publication,
          )
        )
          return refuse('binding');
        const key = { source: { kind: 'library' as const, identity: b.tuple.identity }, scopeId: r.captureId };
        const address = identityScopeAddress(key);
        if (address.partition !== home) return refuse('binding');
        await tx.query(insertSQL.sql, [
          home,
          r.captureId,
          b.holdId,
          b.bindingDigest,
          b.definitionDigest,
          stringify(b),
          stringify(r.definition),
          address.source,
          options.allowance.reservationId,
          accepted.epoch,
          accepted.position.toString(),
          accepted.transactionId,
        ]);
        await tx.query(startSQL.sql, [home, r.captureId, hash({ binding: b.bindingDigest, root: true })]);
        await tx.query(gateStartSQL.sql, [home, r.captureId, b.tuple.identity.receivingEpoch]);
        await tx.query(scopeStartSQL.sql, [
          home,
          address.source,
          r.captureId,
          stringify(key.source),
          b.holdId,
          stringify({
            kind: 'public-output-locator',
            capture: { kind: 'public-output', partition: home, captureId: r.captureId, bindingDigest: b.bindingDigest },
          }),
        ]);
        return {
          status: 'accepted' as const,
          capture: {
            kind: 'public-output' as const,
            partition: home,
            captureId: r.captureId,
            bindingDigest: b.bindingDigest,
          },
        };
      });
    });
  }
  async function currentMappings(
    ids: readonly string[],
    work: NativeCollectionWork,
    deadline: number,
  ): Promise<Mapping[]> {
    const mappings = await readIdentityMappings(pool, ids);
    return mappings.map((m, index) => {
      if (m.state !== 'mapped' || m.original !== ids[index]) return refuse('closure', 'changed');
      return { original: m.original, terminal: m.terminal, epoch: m.epoch.toString() };
    });
  }
  async function planCuts(mappings: Mapping[], deadline: number): Promise<Cut[]> {
    const result: Cut[] = [];
    for (const m of mappings) {
      const route = routeOf(m.original);
      if (route === null) return refuse('closure');
      const row = await read(deadline, (tx) =>
        one<{ control_partition: number; control_group: string; terminal: string; epoch: string }>(tx, mappingSQL, [
          route,
          m.original,
        ]),
      );
      if (!row || row.terminal !== m.terminal || row.control_group !== m.terminal) return refuse('closure', 'changed');
      const group = await read(deadline, (tx) =>
        one<{ generation: string; published_epoch: string }>(tx, cutGroupReadSQL, [
          row.control_partition,
          row.control_group,
        ]),
      );
      if (!group || group.published_epoch !== m.epoch) return refuse('closure', 'changed');
      result.push({
        home: row.control_partition,
        original: m.original,
        terminal: m.terminal,
        generation: group.generation,
        epoch: m.epoch,
      });
    }
    return result;
  }
  async function cut(a: Accepted, c: Cut, deadline: number): Promise<IdentityNativeReceipt> {
    const l = locator(a),
      key = scope(a),
      directoryKey = hash({ source: a.scope_key, scope: a.capture_id });
    const prior = await read(deadline, (tx) =>
      one<{ native_epoch: number; native_position: string; transaction_id: string }>(tx, cutSQL, [
        c.home,
        l.partition,
        l.captureId,
        c.original,
        directoryKey,
      ]),
    );
    if (prior) return receipt(c.home, prior);
    await command(c.home, deadline, l.captureId, async (tx) => {
      const g = await one<{ generation: string; version: string; owner_epoch: number; published_epoch: string }>(
        tx,
        cutGroupSQL,
        [c.home, c.terminal],
      );
      if (!g || g.generation !== c.generation || g.published_epoch !== c.epoch) return refuse('closure', 'changed');
      await tx.query(slotSQL.sql, [c.home, l.partition, l.captureId, c.original, c.generation, c.terminal, false]);
      const slot = await one<{ generation: string; terminal: string; released: boolean }>(tx, slotLockSQL, [
        c.home,
        l.partition,
        l.captureId,
        c.original,
      ]);
      if (!slot || slot.released || slot.generation !== c.generation || slot.terminal !== c.terminal)
        return refuse('fenced');
      await tx.query(bridgeSQL.sql, [c.home, c.generation, c.terminal, g.owner_epoch, g.version]);
      const b = await one<{
        job_id: string | null;
        closed_job: string | null;
        terminal: string;
        owner_epoch: number;
        basis_version: string;
      }>(tx, bridgeLockSQL, [c.home, c.generation]);
      if (
        !b ||
        b.job_id ||
        b.closed_job ||
        b.terminal !== c.terminal ||
        b.owner_epoch !== g.owner_epoch ||
        b.basis_version !== g.version ||
        !(await one(tx, cutMemberSQL, [c.home, c.generation, c.original, c.terminal]))
      )
        return refuse('closure');
      const n = await component(tx, 'identity-scope-enrollment');
      await tx.query(settingSQL.sql, [n.transactionId]);
      registerCommandCallback(tx, async () => {
        await tx.query(cutInsertSQL.sql, [
          c.home,
          c.generation,
          c.original,
          directoryKey,
          a.binding.holdId,
          stringify(key),
          l.captureId,
          l.partition,
          a.binding.tuple.identity.ownerEpoch,
          n.transactionId,
          a.scope_key,
          stringify(key.source),
          c.terminal,
          c.epoch,
          n.position.toString(),
          n.epoch,
        ]);
      });
    });
    const retained = await read(deadline, (tx) =>
      one<{ native_epoch: number; native_position: string; transaction_id: string }>(tx, cutSQL, [
        c.home,
        l.partition,
        l.captureId,
        c.original,
        directoryKey,
      ]),
    );
    if (!retained) return refuse('provenance');
    return receipt(c.home, retained);
  }
  async function capturePage(
    l: T.PublicIdentityOutputCapture,
    continuation: string,
    inputLimit: number,
    options: T.PublicIdentityOutputWork,
  ) {
    if (!Number.isInteger(inputLimit) || inputLimit < 1 || inputLimit > 100 || !/^(0|[1-9][0-9]*)$/.test(continuation))
      throw new TypeError('Invalid bounded output continuation');
    return execute(options, async (work) => {
      const a = await read(options.deadline, (tx) => load(tx, l));
      let p = await command(l.partition, options.deadline, l.captureId, async (tx) => {
        await eligible(tx, a, work, options.deadline);
        const p = await one<Progress>(tx, progressSQL, [l.partition, l.captureId]);
        if (!p || p.version !== continuation) return refuse('continuation', 'changed');
        await component(tx);
        return p;
      });
      if (p.exhausted) return { status: 'exhausted' as const, capture: l, continuation: p.version };
      if (!p.pending) {
        const page = await work.compose(async (allowance) =>
          (await native()).readNativePublicCollectionOutput(pool, a.binding.tuple.identity, {
            allowance,
            deadline: options.deadline,
            after: p!.after_key,
            limit: Math.min(inputLimit, 8),
          }),
        );
        if (page.status !== 'ready' || !samePublication(page.tuple, a.binding.tuple))
          return refuse('current', 'changed');
        if (
          page.rows.length > Math.min(inputLimit, 8) ||
          page.rows.some((r: CanonicalRangeKey) => r.driver !== 'output') ||
          !equal(page.after, page.rows.at(-1) ?? p.after_key) ||
          (!page.exhausted && (!page.rows.length || equal(page.after, p.after_key)))
        )
          return refuse('continuation');
        const originals = [...new Set<string>(page.rows.map((r: CanonicalRangeKey) => r.storedSubjectId))];
        const first = await currentMappings(originals, work, options.deadline);
        const terminals = await currentMappings([...new Set(first.map((m) => m.terminal))], work, options.deadline);
        if (
          terminals.some((m) => m.original !== m.terminal) ||
          first.some((m) => !terminals.some((t) => t.original === m.terminal && t.epoch === m.epoch))
        )
          return refuse('closure', 'changed');
        const all = [...first, ...terminals.filter((t) => !first.some((m) => m.original === t.original))];
        const pending = bounded(
          {
            before: p.after_key,
            after: page.after,
            exhausted: page.exhausted,
            rows: page.rows,
            mappings: first,
            cuts: await planCuts(all, options.deadline),
          },
          65536,
        );
        await command(l.partition, options.deadline, l.captureId, async (tx) => {
          await eligible(tx, a, work, options.deadline);
          const now = await one<Progress>(tx, progressSQL, [l.partition, l.captureId]);
          if (!now || now.version !== continuation || now.pending) return refuse('continuation', 'changed');
          if (
            (await tx.query(planSQL.sql, [l.partition, l.captureId, continuation, stringify(pending)])).rowCount !== 1
          )
            return refuse('continuation');
          await component(tx);
        });
        p = { ...p, pending };
      }
      const plan = p.pending!;
      // Every send was durably planned before releasing the Collection home. Replay sends only this plan.
      const receipts: IdentityNativeReceipt[] = [];
      for (const c of plan.cuts) receipts.push(await cut(a, c, options.deadline));
      const current = await currentMappings(
        plan.cuts.map((c) => c.original),
        work,
        options.deadline,
      );
      if (
        !equal(
          current,
          plan.cuts.map((c) => ({ original: c.original, terminal: c.terminal, epoch: c.epoch })),
        )
      )
        return refuse('closure', 'changed');
      return command(l.partition, options.deadline, l.captureId, async (tx) => {
        await eligible(tx, a, work, options.deadline);
        const now = await one<Progress>(tx, progressSQL, [l.partition, l.captureId]);
        if (!now || now.version !== continuation || !equal(now.pending, plan)) return refuse('continuation', 'changed');
        const version = (BigInt(now.version) + 1n).toString(),
          body = bounded({ ...plan, receipts }, 65536),
          manifest = hash({ previous: now.manifest_digest, version, body });
        const n = await component(tx);
        await tx.query(pageSQL.sql, [
          l.partition,
          l.captureId,
          version,
          now.manifest_digest,
          manifest,
          stringify(body),
          n.epoch,
          n.position.toString(),
          n.transactionId,
        ]);
        const inserted = await tx.query(originalsSQL.sql, [l.partition, l.captureId, stringify(plan.mappings)]);
        await tx.query(advanceSQL.sql, [
          l.partition,
          l.captureId,
          continuation,
          stringify(plan.after),
          plan.exhausted,
          manifest,
          plan.rows.length,
          inserted.rowCount,
        ]);
        return {
          status: plan.exhausted ? ('exhausted' as const) : ('progress' as const),
          capture: l,
          continuation: version,
        };
      });
    });
  }
  async function seal(l: T.PublicIdentityOutputCapture, options: T.PublicIdentityOutputWork) {
    return execute(options, (work) =>
      command(l.partition, options.deadline, l.captureId, async (tx) => {
        const a = await load(tx, l);
        await eligible(tx, a, work, options.deadline);
        const previous = await one<Seal>(tx, sealSQL, [l.partition, l.captureId]);
        if (previous) {
          await component(tx);
          return {
            status: 'sealed' as const,
            seal: { capture: l, manifestDigest: previous.manifest_digest, native: receipt(l.partition, previous) },
          };
        }
        const p = await one<Progress>(tx, progressSQL, [l.partition, l.captureId]);
        if (!p || !p.exhausted || p.pending) return refuse('closure');
        const n = await component(tx);
        await tx.query(sealInsertSQL.sql, [
          l.partition,
          l.captureId,
          p.manifest_digest,
          p.version,
          p.raw_count,
          p.canonical_count,
          n.epoch,
          n.position.toString(),
          n.transactionId,
        ]);
        if ((await tx.query(scopeSealSQL.sql, [l.partition, a.scope_key, l.captureId])).rowCount !== 1)
          return refuse('closure');
        return { status: 'sealed' as const, seal: { capture: l, manifestDigest: p.manifest_digest, native: n } };
      }),
    );
  }
  async function ready(l: T.PublicIdentityOutputCapture, options: T.PublicIdentityOutputWork) {
    return execute(options, (work) =>
      command(l.partition, options.deadline, l.captureId, async (tx) => {
        const a = await load(tx, l);
        await eligible(tx, a, work, options.deadline);
        const s = await one<Seal>(tx, sealSQL, [l.partition, l.captureId]);
        if (!s) return refuse('closure');
        await component(tx);
        return {
          status: 'ready' as const,
          seal: { capture: l, manifestDigest: s.manifest_digest, native: receipt(l.partition, s) },
          committedRevision: 1n,
        };
      }),
    );
  }
  async function canonicalRead(
    l: T.PublicIdentityOutputCapture,
    options: T.PublicIdentityOutputWork,
    selection: { after: string | null; limit: number } | { originals: readonly string[] },
  ) {
    if ('limit' in selection) {
      if (!Number.isInteger(selection.limit) || selection.limit < 1 || selection.limit > 100)
        throw new RangeError('Canonical prefix limit must be 1..100');
      if (selection.after !== null) id(selection.after);
    } else {
      if (selection.originals.length > 100) throw new RangeError('Canonical membership limit must be <=100');
      selection.originals.forEach(id);
    }
    return execute(options, (work) =>
      command(l.partition, options.deadline, l.captureId, async (tx) => {
        const a = await load(tx, l);
        await eligible(tx, a, work, options.deadline);
        const s = await one<Seal>(tx, sealSQL, [l.partition, l.captureId]);
        if (!s) return refuse('closure');
        const rows =
          'limit' in selection
            ? (
                await tx.query<{ terminal: string }>(prefixSQL.sql, [
                  l.partition,
                  l.captureId,
                  selection.after,
                  selection.limit + 1,
                ])
              ).rows
            : (await tx.query<{ terminal: string }>(membershipSQL.sql, [l.partition, l.captureId, selection.originals]))
                .rows;
        await component(tx);
        const limit = 'limit' in selection ? selection.limit : 100;
        return {
          status: 'ready' as const,
          terminals: rows.slice(0, limit).map((r) => r.terminal),
          after: rows.length > limit ? rows[limit - 1]!.terminal : null,
          seal: { capture: l, manifestDigest: s.manifest_digest, native: receipt(l.partition, s) },
        };
      }),
    );
  }
  async function enrollConsumer(
    l: T.PublicIdentityOutputCapture,
    consumerId: string,
    options: T.PublicIdentityOutputWork,
  ) {
    id(consumerId);
    return execute(options, (work) =>
      command(l.partition, options.deadline, l.captureId, async (tx) => {
        const a = await load(tx, l);
        await eligible(tx, a, work, options.deadline);
        if (!(await one(tx, sealSQL, [l.partition, l.captureId]))) return refuse('closure');
        const n = await component(tx);
        // Intent precedes every foreign writer dispatch. Missing closure of even an uncertain intent retains custody.
        await tx.query(consumerSQL.sql, [
          l.partition,
          l.captureId,
          consumerId,
          n.epoch,
          n.position.toString(),
          n.transactionId,
        ]);
        return { status: 'enrolled' as const, capture: l, consumerId };
      }),
    );
  }
  async function closeCut(a: Accepted, c: Cut, deadline: number): Promise<void> {
    const l = locator(a),
      directoryKey = hash({ source: a.scope_key, scope: a.capture_id });
    if (await read(deadline, (tx) => one(tx, cutReleasedSQL, [c.home, l.partition, l.captureId, c.original]))) return;
    await command(c.home, deadline, l.captureId, async (tx) => {
      // This tombstone also covers a planned send which never reached its foreign home.
      await tx.query(slotSQL.sql, [c.home, l.partition, l.captureId, c.original, c.generation, c.terminal, true]);
      const slot = await one<{ generation: string; terminal: string; released: boolean }>(tx, slotLockSQL, [
        c.home,
        l.partition,
        l.captureId,
        c.original,
      ]);
      if (!slot || slot.generation !== c.generation || slot.terminal !== c.terminal) return refuse('closure');
      const bridge = await one<{ job_id: string | null; closed_job: string | null }>(tx, bridgeLockSQL, [
        c.home,
        c.generation,
      ]);
      if (bridge && (bridge.job_id || bridge.closed_job)) return refuse('closure');
      if (
        await one(tx, cutLiveSQL, [
          c.home,
          c.generation,
          c.original,
          l.partition,
          l.captureId,
          a.binding.holdId,
          directoryKey,
          a.scope_key,
        ])
      )
        return refuse(
          'foreign_closure_missing',
          'unavailable',
          'semantic.identity-epoch.platform-native-inverse-removal',
        );
      const n = await component(tx, 'identity-scope-directory-release');
      await tx.query(settingSQL.sql, [n.transactionId]);
      registerCommandCallback(tx, async () => {
        await tx.query(cutReleaseSQL.sql, [
          c.home,
          l.partition,
          l.captureId,
          c.original,
          n.epoch,
          n.position.toString(),
          n.transactionId,
        ]);
      });
    });
    if (!(await read(deadline, (tx) => one(tx, cutReleasedSQL, [c.home, l.partition, l.captureId, c.original]))))
      return refuse('provenance');
  }
  async function cancel(l: T.PublicIdentityOutputCapture, options: T.PublicIdentityOutputWork) {
    return execute(options, async (work) => {
      const a = await command(l.partition, options.deadline, l.captureId, async (tx) => {
        const a = await load(tx, l);
        await one(tx, scopeSQL, [l.partition, a.scope_key, l.captureId]);
        const fence = await one<{ kind: string }>(tx, fenceSQL, [l.partition, l.captureId]);
        if (fence && fence.kind !== 'cancelled') return refuse('fenced');
        const n = await component(tx, 'identity-public-output-cancelled');
        if (!fence) {
          await tx.query(fenceInsertSQL.sql, [
            l.partition,
            l.captureId,
            'cancelled',
            n.epoch,
            n.position.toString(),
            n.transactionId,
          ]);
          if (
            (
              await tx.query(gateCloseSQL.sql, [
                l.partition,
                l.captureId,
                'cancelled',
                n.epoch,
                n.position.toString(),
                n.transactionId,
                a.binding.tuple.identity.receivingEpoch,
              ])
            ).rowCount !== 1
          )
            return refuse('provenance');
        } else if ((await gate(tx, a)).state !== 'cancelled') return refuse('provenance');
        return a;
      });
      const p = await command(l.partition, options.deadline, l.captureId, async (tx) => {
        await one(tx, scopeSQL, [l.partition, a.scope_key, l.captureId]);
        await noForeignReceivers(tx, a);
        const p = await one<Progress>(tx, progressSQL, [l.partition, l.captureId]);
        if (!p) return refuse('closure');
        const page = await one<{ body: Plan }>(tx, plansSQL, [l.partition, l.captureId, p.closure_after]);
        await component(tx);
        return { progress: p, plan: page?.body ?? (BigInt(p.closure_after) === BigInt(p.version) ? p.pending : null) };
      });
      if (p.plan) {
        for (const c of p.plan.cuts) await closeCut(a, c, options.deadline);
        await command(l.partition, options.deadline, l.captureId, async (tx) => {
          await one(tx, scopeSQL, [l.partition, a.scope_key, l.captureId]);
          const now = await one<Progress>(tx, progressSQL, [l.partition, l.captureId]);
          if (!now || now.closure_after !== p.progress.closure_after) return refuse('continuation', 'changed');
          await tx.query(closeProgressSQL.sql, [l.partition, l.captureId, (BigInt(now.closure_after) + 1n).toString()]);
          await component(tx);
        });
        return { status: 'pending' as const, capture: l };
      }
      return command(l.partition, options.deadline, l.captureId, (tx) =>
        transition(tx, a, 'cancelled', work, options.deadline),
      );
    });
  }
  async function transition(
    tx: CommandTransaction,
    a: Accepted,
    kind: 'applied' | 'cancelled',
    work: NativeCollectionWork,
    deadline: number,
  ) {
    const l = locator(a);
    const replay = await one<{ native_epoch: number; native_position: string; transaction_id: string; kind: string }>(
      tx,
      dispositionLocatorSQL,
      [l.partition, l.captureId],
    );
    if (replay) {
      if (replay.kind !== kind) return refuse('fenced');
      const original: PublicOutputDispositionSelection = {
        captureId: l.captureId,
        holdId: a.binding.holdId,
        bindingDigest: a.binding.bindingDigest,
        disposition: receipt(l.partition, replay),
      };
      const verified = await work.compose(async (allowance) =>
        resolvePublicIdentityOutputCaptureDisposition(tx, original, context(tx, pool, deadline, allowance)),
      );
      if (verified.status !== 'locked' || verified.provenance !== 'committed') return refuse('provenance');
      const result =
        kind === 'applied'
          ? await work.compose(async (allowance) =>
              (await native()).transferNativePublicCollectionOutputHold(
                tx,
                original,
                context(tx, pool, deadline, allowance),
              ),
            )
          : await work.compose(async (allowance) =>
              (await native()).releaseNativePublicCollectionOutputHold(
                tx,
                original,
                context(tx, pool, deadline, allowance),
              ),
            );
      if (result.status !== 'transferred' && result.status !== 'released') return refuse('provenance');
      return { status: kind, capture: l, disposition: original.disposition };
    }
    await one(tx, scopeSQL, [l.partition, a.scope_key, l.captureId]);
    await noForeignReceivers(tx, a);
    const p = await one<Progress>(tx, progressSQL, [l.partition, l.captureId]);
    if (!p) return refuse('closure');
    const seal = await one<Seal>(tx, sealSQL, [l.partition, l.captureId]);
    if (kind === 'applied') {
      if (!seal) return refuse('closure');
      await eligible(tx, a, work, deadline);
    } else if (BigInt(p.closure_after) < BigInt(p.version) + (p.pending ? 1n : 0n)) return refuse('closure');
    const fence = await one<{ kind: string }>(tx, fenceSQL, [l.partition, l.captureId]);
    if (fence && fence.kind !== kind) return refuse('fenced');
    const purpose = kind === 'applied' ? 'identity-public-output-applied' : 'identity-public-output-cancelled';
    const n = await component(tx, purpose);
    if (!fence) {
      await tx.query(fenceInsertSQL.sql, [
        l.partition,
        l.captureId,
        kind,
        n.epoch,
        n.position.toString(),
        n.transactionId,
      ]);
      if (
        (
          await tx.query(gateCloseSQL.sql, [
            l.partition,
            l.captureId,
            kind,
            n.epoch,
            n.position.toString(),
            n.transactionId,
            a.binding.tuple.identity.receivingEpoch,
          ])
        ).rowCount !== 1
      )
        return refuse('provenance');
    }
    const closed = await noForeignReceivers(tx, a);
    if (closed.state !== kind || closed.receiving_epoch !== (BigInt(closed.original_epoch) + 1n).toString())
      return refuse('provenance');
    const successor = kind === 'applied' ? randomUUID() : null;
    const cancellationEpoch = kind === 'cancelled' ? closed.receiving_epoch : null;
    // Immutable stage precedes native transfer. Its actual native xid and deferred component,
    // rather than this UUID or a process cache, establish successor selection authority.
    if (
      (
        await tx.query(stageSQL.sql, [
          l.partition,
          l.captureId,
          a.binding.holdId,
          a.binding.bindingDigest,
          kind,
          purpose,
          successor,
          cancellationEpoch,
          kind === 'applied' ? seal!.manifest_digest : null,
          kind === 'applied' ? seal!.transaction_id : null,
          n.epoch,
          n.position.toString(),
          n.transactionId,
        ])
      ).rowCount !== 1
    )
      return refuse('provenance');
    await tx.query(dispositionInsertSQL.sql, [
      l.partition,
      l.captureId,
      a.binding.holdId,
      a.binding.bindingDigest,
      kind,
      kind === 'applied' ? seal!.manifest_digest : null,
      kind === 'applied' ? seal!.transaction_id : null,
      n.epoch,
      n.position.toString(),
      n.transactionId,
    ]);
    const selection: PublicOutputDispositionSelection = {
      captureId: l.captureId,
      holdId: a.binding.holdId,
      bindingDigest: a.binding.bindingDigest,
      disposition: n,
    };
    const result =
      kind === 'applied'
        ? await work.compose(async (allowance) =>
            (await native()).transferNativePublicCollectionOutputHold(
              tx,
              selection,
              context(tx, pool, deadline, allowance),
            ),
          )
        : await work.compose(async (allowance) =>
            (await native()).releaseNativePublicCollectionOutputHold(
              tx,
              selection,
              context(tx, pool, deadline, allowance),
            ),
          );
    if (result.status !== 'transferred' && result.status !== 'released') return refuse('current');
    const nativeReceipt = result.status === 'transferred' ? result.transfer : result.release;
    if (!equal(nativeReceipt, n) || (result.status === 'transferred' && result.successorHoldId !== successor))
      return refuse('provenance');
    await tx.query(transitionSQL.sql, [
      l.partition,
      l.captureId,
      kind,
      result.status === 'transferred' ? result.successorHoldId : null,
      n.epoch,
      n.position.toString(),
      n.transactionId,
    ]);
    return { status: kind, capture: l, disposition: n };
  }
  async function apply(l: T.PublicIdentityOutputCapture, options: T.PublicIdentityOutputWork) {
    return execute(options, (work) =>
      command(l.partition, options.deadline, l.captureId, async (tx) =>
        transition(tx, await load(tx, l), 'applied', work, options.deadline),
      ),
    );
  }
  return {
    accept: captureAcceptance,
    capturePage,
    seal,
    ready,
    revalidate: ready,
    membership: (l: T.PublicIdentityOutputCapture, originals: readonly string[], options: T.PublicIdentityOutputWork) =>
      canonicalRead(l, options, { originals }),
    prefix: (
      l: T.PublicIdentityOutputCapture,
      after: string | null,
      limit: number,
      options: T.PublicIdentityOutputWork,
    ) => canonicalRead(l, options, { after, limit }),
    enrollConsumer,
    cancel,
    apply,
  };
}

/** Commerce calls this on the actual original Collection command. No caller payload is evidence. */
export const resolvePublicIdentityOutputCaptureDisposition: LockPublicOutputDisposition = async (
  tx,
  selection,
  ctx,
) => {
  const command = currentCommand(tx),
    resources = currentCommandResources(tx);
  if (
    resources.pool !== ctx.pool ||
    command.time !== ctx.at ||
    command.partition !== selection.disposition.partition ||
    ctx.deadline > resources.deadline
  )
    throw new TypeError('Public output disposition requires the genuine same Pool/home/T');
  const work = new NativeCollectionWork(ctx.allowance, ctx.deadline);
  try {
    return await instrumentNativeCollectionWork(
      ctx.pool,
      work,
      (sql, values) => outputCaptureFootprint(work, sql, values),
      async () => {
        const l: T.PublicIdentityOutputCapture = {
          kind: 'public-output',
          partition: command.partition,
          captureId: selection.captureId,
          bindingDigest: selection.bindingDigest,
        };
        const a = await load(tx, l);
        if (a.binding.holdId !== selection.holdId)
          return { status: 'unavailable' as const, reason: 'binding' as const, work: work.receipt() };
        const d = await one<Disposition>(tx, dispositionSQL, [
          l.partition,
          l.captureId,
          selection.holdId,
          selection.bindingDigest,
          selection.disposition.transactionId,
          command.transactionId,
          selection.disposition.epoch,
          selection.disposition.position.toString(),
        ]);
        if (!d) return { status: 'unavailable' as const, reason: 'disposition_missing' as const, work: work.receipt() };
        const closed = await noForeignReceivers(tx, a);
        if (closed.state !== d.kind || closed.receiving_epoch !== (BigInt(closed.original_epoch) + 1n).toString())
          return {
            status: 'unavailable' as const,
            dependency: 'semantic.public-output.enrollment-fence',
            work: work.receipt(),
          };
        const p = await one<Progress>(tx, progressSQL, [l.partition, l.captureId]);
        const seal = await one<Seal>(tx, sealSQL, [l.partition, l.captureId]);
        if (
          d.kind === 'applied' &&
          (!seal || seal.transaction_id !== d.seal_transaction_id || seal.manifest_digest !== d.manifest_digest)
        )
          return { status: 'unavailable' as const, reason: 'seal_missing' as const, work: work.receipt() };
        if (d.kind === 'cancelled' && (!p || BigInt(p.closure_after) < BigInt(p.version) + (p.pending ? 1n : 0n)))
          return { status: 'unavailable' as const, reason: 'closure_missing' as const, work: work.receipt() };
        const disposition = receipt(l.partition, d);
        const common = {
          status: 'locked' as const,
          binding: a.binding,
          disposition,
          provenance: d.staged ? ('staged' as const) : ('committed' as const),
          work: work.receipt(),
        };
        if (d.kind === 'applied') {
          if (
            !seal ||
            !d.successor_hold_id ||
            d.successor_hold_id === a.binding.holdId ||
            d.purpose !== 'identity-public-output-applied'
          )
            return {
              status: 'unavailable' as const,
              dependency: 'semantic.public-output.staged-successor',
              work: work.receipt(),
            };
          return {
            ...common,
            kind: 'applied' as const,
            purpose: d.purpose,
            manifestDigest: seal.manifest_digest,
            seal: receipt(l.partition, seal),
            successorHoldId: d.successor_hold_id,
            transfer: disposition,
          } satisfies LockedPublicOutputDisposition;
        }
        if (
          d.cancellation_epoch !== (BigInt(a.binding.tuple.identity.receivingEpoch) + 1n).toString() ||
          d.purpose !== 'identity-public-output-cancelled'
        )
          return {
            status: 'unavailable' as const,
            dependency: 'semantic.public-output.cancellation-fence',
            work: work.receipt(),
          };
        return {
          ...common,
          kind: 'cancelled' as const,
          purpose: d.purpose,
          cancellationEpoch: d.cancellation_epoch,
          cancellation: disposition,
        } satisfies LockedPublicOutputDisposition;
      },
      tx as PoolClient,
    );
  } catch (error) {
    if (error instanceof Refusal)
      return {
        status: error.status,
        dependency: error.dependency ?? 'semantic.public-output.' + error.reason,
        work: work.receipt(),
      };
    if (error instanceof Error) Object.defineProperty(error, 'work', { get: () => work.receipt(), configurable: true });
    throw error;
  }
};

/** Source-local current guard for the explicit variant. The caller transfers its own remainder. */
export async function lockPublicIdentityOutputCaptureCurrent(
  tx: CommandTransaction,
  selection: T.PublicIdentityOutputCapture | IdentityScopeKey,
  ctx: PublicOutputCommandContext,
  retained = false,
) {
  const command = currentCommand(tx),
    resources = currentCommandResources(tx);
  const home = 'kind' in selection ? selection.partition : identityScopeAddress(selection).partition;
  if (
    resources.pool !== ctx.pool ||
    command.time !== ctx.at ||
    command.partition !== home ||
    ctx.deadline > resources.deadline
  )
    throw new TypeError('Public output current requires the genuine same Pool/home/T');
  const work = new NativeCollectionWork(ctx.allowance, ctx.deadline);
  try {
    return await instrumentNativeCollectionWork(
      ctx.pool,
      work,
      (sql, values) => outputCaptureFootprint(work, sql, values),
      async () => {
        let l: T.PublicIdentityOutputCapture;
        if ('kind' in selection) l = selection;
        else {
          const address = identityScopeAddress(selection);
          const row = await one<{ capture: { kind: string; capture: T.PublicIdentityOutputCapture }; source: object }>(
            tx,
            scopeSQL,
            [address.partition, address.source, address.scope],
          );
          if (!row || row.capture.kind !== 'public-output-locator' || !equal(row.source, selection.source))
            return refuse('binding');
          l = row.capture.capture;
        }
        const a = await load(tx, l);
        if (!('kind' in selection) && !equal(scope(a), selection)) return refuse('binding');
        if (!retained) await eligible(tx, a, work, ctx.deadline);
        const seal = await one<Seal>(tx, sealSQL, [l.partition, l.captureId]);
        if (!retained && !seal) return refuse('closure');
        return {
          status: retained ? ('retained' as const) : ('current' as const),
          key: scope(a),
          capture: l,
          committedRevision: 1n,
          work: work.receipt(),
        };
      },
      tx as PoolClient,
    );
  } catch (error) {
    if (error instanceof Refusal)
      return {
        status: error.status,
        reason: error.reason,
        ...(error.dependency ? { dependency: error.dependency } : {}),
        work: work.receipt(),
      };
    if (error instanceof Error) Object.defineProperty(error, 'work', { get: () => work.receipt(), configurable: true });
    throw error;
  }
}

export async function readPublicIdentityOutputCaptureCurrent(
  pool: Pool,
  selection: T.PublicIdentityOutputCapture | IdentityScopeKey,
  options: T.PublicIdentityOutputWork,
) {
  const work = new NativeCollectionWork(options.allowance, options.deadline);
  const home = 'kind' in selection ? selection.partition : identityScopeAddress(selection).partition;
  try {
    const result = await instrumentNativeCollectionWork(
      pool,
      work,
      (sql, values) => outputCaptureFootprint(work, sql, values),
      () =>
        withSingleCommandAttempt(() =>
          runCommand(pool, { partition: home, deadline: options.deadline }, async (tx) => {
            const result = await work.compose((allowance) =>
              lockPublicIdentityOutputCaptureCurrent(tx, selection, context(tx, pool, options.deadline, allowance)),
            );
            if (result.status !== 'current') return refuse('current', 'changed');
            await component(tx);
            return { value: result, events: [{ type: EVENT, data: { captureId: result.capture.captureId } }] };
          }),
        ),
    );
    return { ...result.value, work: work.receipt() };
  } catch (error) {
    if (error instanceof Refusal)
      return {
        status: error.status,
        reason: error.reason,
        ...(error.dependency ? { dependency: error.dependency } : {}),
        work: work.receipt(),
      };
    if (error instanceof Error) Object.defineProperty(error, 'work', { get: () => work.receipt(), configurable: true });
    throw error;
  }
}

/** Original pre-arm receipts invalidate even a stale retained output; they never grant fresh eligibility. */
export function receivePublicIdentityOutputCapturePrearm(
  pool: Pool,
  selection: import('./identity-epoch-prearm-contract.ts').IdentityPrearmTicketLocator,
  options: T.PublicIdentityOutputWork,
  cancellation?: IdentityNativeReceipt,
) {
  return withRequestDeadline(options.deadline, () => receiveOutputPrearm(pool, selection, options, cancellation));
}

async function receiveOutputPrearm(
  pool: Pool,
  selection: import('./identity-epoch-prearm-contract.ts').IdentityPrearmTicketLocator,
  options: T.PublicIdentityOutputWork,
  cancellation?: IdentityNativeReceipt,
) {
  const work = new NativeCollectionWork(options.allowance, options.deadline);
  try {
    return await instrumentNativeCollectionWork(
      pool,
      work,
      (sql, values) => outputCaptureFootprint(work, sql, values),
      async () => {
        const { readIdentityPrearmTicket } = await import('./identity-epoch-prearm-contract.ts');
        const ticket = await readIdentityPrearmTicket(pool, selection);
        if (!ticket || ticket.scope.source.kind !== 'library' || ticket.scope.source.identity.scope !== 'public_output')
          return refuse('provenance');
        const address = identityScopeAddress(ticket.scope),
          home = address.partition;
        if (cancellation) {
          const { identityJobPartition } = await import('./identity-adapters/index.ts');
          if (cancellation.partition !== identityJobPartition(ticket.locator.job)) return refuse('provenance');
          const closed = await withReadTransaction(
            pool,
            (tx) =>
              one(tx, prearmCancelledSQL, [
                cancellation.partition,
                ticket.locator.job.jobId,
                ticket.locator.job.epoch.toString(),
                cancellation.transactionId,
                cancellation.epoch,
                cancellation.position.toString(),
              ]),
            options.deadline,
          );
          if (!closed) return refuse('provenance');
        }
        const keys = [
          home,
          address.source,
          address.scope,
          ticket.registration,
          ticket.locator.job.jobId,
          ticket.locator.job.epoch.toString(),
        ];
        const disposition = cancellation ? 'cancelled' : 'unsafe';
        const purpose = cancellation ? 'identity-scope-cancellation' : 'identity-scope-preparation';
        await withSingleCommandAttempt(() =>
          runCommand(pool, { partition: home, deadline: options.deadline }, async (tx) => {
            const row = await one<{
              capture: { kind: string; capture: T.PublicIdentityOutputCapture };
              source: object;
              revision: string;
              capture_id: string;
              registration: string;
              state: string;
            }>(tx, scopeSQL, [home, address.source, address.scope]);
            if (
              !row ||
              row.capture.kind !== 'public-output-locator' ||
              row.registration !== ticket.registration ||
              row.capture_id !== ticket.captureId ||
              row.state === 'retired'
            )
              return refuse('provenance');
            const a = await load(tx, row.capture.capture);
            if (!equal(scope(a), ticket.scope) || !equal(row.source, ticket.scope.source)) return refuse('binding');
            const prior = await one<{ state: string; attempt: object }>(tx, prearmAttemptSQL, keys);
            if (prior && !equal(prior.attempt, ticket.attempt)) return refuse('provenance');
            if (!cancellation && prior && prior.state !== 'active') return refuse('fenced');
            const transition = cancellation ? prior?.state !== 'cancelled' : !prior;
            if (transition) {
              await tx.query(prearmUnsafeSQL.sql, [
                home,
                address.source,
                address.scope,
                cancellation ? (prior?.state === 'active' ? -1 : 0) : 1,
              ]);
              await tx.query(prearmAttemptInsertSQL.sql, [
                ...keys,
                stringify(ticket.attempt),
                cancellation ? 'cancelled' : 'active',
                currentCommand(tx).transactionId,
                (BigInt(row.revision) + 1n).toString(),
              ]);
            }
            await tx.query(prearmReceiptInsertSQL.sql, [
              ...keys,
              ticket.locator.directory.transactionId,
              ticket.locator.pageId,
              ticket.locator.ordinal,
              disposition,
              currentCommand(tx).transactionId,
            ]);
            await component(tx, purpose);
            return { value: null, events: [{ type: EVENT, data: { captureId: ticket.captureId } }] };
          }),
        );
        const r = await withReadTransaction(
          pool,
          (tx) =>
            one<{ native_epoch: number; native_position: string; transaction_id: string }>(tx, prearmReceiptSQL, [
              ...keys,
              ticket.locator.directory.transactionId,
              ticket.locator.pageId,
              ticket.locator.ordinal,
              disposition,
              purpose,
            ]),
          options.deadline,
        );
        if (!r) return refuse('provenance');
        return { status: 'received' as const, native: receipt(home, r), work: work.receipt() };
      },
    );
  } catch (error) {
    if (error instanceof Refusal)
      return {
        status: error.status,
        reason: error.reason,
        ...(error.dependency ? { dependency: error.dependency } : {}),
        work: work.receipt(),
      };
    if (error instanceof Error) Object.defineProperty(error, 'work', { get: () => work.receipt(), configurable: true });
    throw error;
  }
}
