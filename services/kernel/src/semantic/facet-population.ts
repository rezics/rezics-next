import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { PoolClient } from 'pg';
import { withConnection } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';
import { PARTITIONS, partitionOf, routeOf } from '../route/route.ts';
import { createPublicFilterSourceBinding } from './public-filter-source-binding.ts';
import { createSubjectSourceKeyPages, type SubjectSourceKeyCursor } from './subject-source-key-pages.ts';
import type {
  FacetPopulationPage,
  FacetPopulationRequest,
  FacetPopulationSourceFactory,
} from './facet-population-contract.ts';
import type { PublicFilterCost, PublicFilterSourceFactory } from './public-filter-source-contract.ts';

const sql = (name: string) => readFileSync(new URL(`./facet-population-${name}.sql`, import.meta.url), 'utf8');
const loadSql = sql('read');
const appendSql = sql('append');
const replaySql = sql('replay');
const bridgeSql = sql('bridge');
const anchorSql = sql('anchor');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const lifetime = 24 * 60 * 60 * 1000;

type Subject = Readonly<{ partition: number; subject: string }>;
type State = {
  partition: number;
  phase: 'keys' | 'bridge' | 'anchor' | 'seal';
  after: SubjectSourceKeyCursor | null;
  epoch: number | null;
  base: string | null;
  through: string | null;
  position: string | null;
  sequence: number;
  eventCount: number | null;
  pending: string | null;
};
type Retained = {
  frontier: string;
  observation: string;
  binding: string;
  capture: string;
  state: State;
  subjects: Subject[];
  complete: boolean;
  expires: string;
  replay_keys?: number;
};
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
function plus(left: PublicFilterCost, right: Partial<PublicFilterCost>): PublicFilterCost {
  return Object.fromEntries(
    Object.entries(left).map(([key, value]) => [key, value + (right[key as keyof PublicFilterCost] ?? 0)]),
  ) as PublicFilterCost;
}
// Fingerprints detect mutation of retained input. Only the native binding reader establishes authority.
function fingerprint(value: unknown): string {
  const stable = (input: unknown): unknown =>
    typeof input === 'bigint'
      ? ['bigint', String(input)]
      : Array.isArray(input)
        ? input.map(stable)
        : input && typeof input === 'object'
          ? Object.fromEntries(
              Object.entries(input)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([k, v]) => [k, stable(v)]),
            )
          : input;
  return createHash('sha256')
    .update(JSON.stringify(stable(value)))
    .digest('hex');
}
function validate(request: FacetPopulationRequest) {
  if (!Number.isInteger(request.inputLimit) || request.inputLimit < 1 || request.inputLimit > 1000)
    throw new RangeError('Population inputLimit must be an integer from 1 through 1000');
  if (typeof request.population !== 'string' || request.population.length < 1 || request.population.length > 1024)
    throw new TypeError('Population must name a registered native read definition');
  if (request.frontier !== null && !UUID.test(request.frontier)) throw new TypeError('Invalid population frontier');
  const capture = request.capture;
  if (
    capture.kind !== 'population' ||
    !Number.isFinite(capture.context.deadline) ||
    (capture.start === null ? capture.execution !== undefined : typeof capture.execution !== 'string')
  )
    throw new TypeError('Population requires the canonical observation capture');
}
const initial = (): State => ({
  partition: 0,
  phase: 'keys',
  after: null,
  epoch: null,
  base: null,
  through: null,
  position: null,
  sequence: 0,
  eventCount: null,
  pending: null,
});
function advanceHome(state: State): State {
  const partition = state.partition + 1;
  return { ...initial(), partition, phase: partition === PARTITIONS ? 'seal' : 'keys' };
}

/** Preparation only. No scheduler, public values, permission cache, consumer registry or ACK writer. */
export const createNativeFacetPopulationSource: FacetPopulationSourceFactory = (config) => {
  if (config.routeKey.byteLength < 32 || typeof config.clock !== 'function')
    throw new TypeError('Population requires native Source configuration');
  const binding = createPublicFilterSourceBinding(config.pool, config.routeKey, config.access);
  const keys = createSubjectSourceKeyPages(config.pool, config.routeKey, config.access);
  // This is the existing three-reader producer name/signature, not an invented fourth reader.
  // Its absence cannot make a provisional FAA adapter return a positive population.
  const sourcePath = new URL('./public-filter-source.ts', import.meta.url).pathname;
  let source: ReturnType<PublicFilterSourceFactory> | undefined;
  async function sourceReader() {
    if (source) return source;
    if (!(await Bun.file(sourcePath).exists())) return undefined;
    const module = (await import(sourcePath)) as { publicFilterSource: PublicFilterSourceFactory };
    source = module.publicFilterSource(config);
    return source;
  }
  return {
    async readFacetPopulationPage(request): Promise<FacetPopulationPage> {
      validate(request);
      let cost = zero();
      const fail = (status: 'changed' | 'unready' | 'unavailable'): FacetPopulationPage => ({ status, cost });
      const context = request.capture.context;
      if (Date.now() >= context.deadline) return fail('unavailable');
      const joined = await binding.join(
        {
          queried: request.capture.queried,
          ...(request.capture.start === null ? {} : { execution: request.capture.execution }),
        },
        context,
      );
      cost = plus(cost, joined.cost);
      if (joined.status !== 'joined') return fail(joined.status);
      if (
        joined.definition.readDefinition !== request.population ||
        (request.capture.start !== null && joined.execution?.start.observation !== request.capture.start.observation)
      )
        return fail('changed');
      const native = await sourceReader();
      if (!native) return fail('unavailable');
      const observed = await native.readPrivacyReductionHeads(request.capture);
      cost = plus(cost, observed.cost);
      if (observed.status !== 'observed') return fail(observed.status === 'home' ? 'unavailable' : observed.status);
      if (observed.changed.length || observed.blocking.some((entry) => entry.phase === 'changed'))
        return fail('changed');
      if (!observed.routingComplete || observed.unacknowledged.length || observed.blocking.length)
        return fail('unready');
      const signature = fingerprint({
        source: joined.definition.source,
        definition: request.population,
        meaning: joined.definition.meaning.digest,
      });
      const captured = fingerprint({
        // Native join validates PIT renewal. Its rotating transport ID is not immutable capture identity.
        queried: {
          consumer: joined.queried.consumer,
          snapshot:
            joined.queried.snapshot.kind === 'pit'
              ? { kind: 'pit', observation: joined.queried.snapshot.observation }
              : joined.queried.snapshot,
        },
        start: request.capture.start,
        execution: request.capture.execution,
      });
      const owner = joined.definition.source;
      const now = config.clock().getTime();
      async function storage<T>(work: (client: PoolClient) => Promise<T>): Promise<T | null> {
        return withConnection(config.pool, async (client) => {
          const home = await readPartition(client, owner.partition);
          cost = plus(cost, { dependencyPoints: 1 });
          if (!home || home.epoch !== owner.epoch || home.writeState !== 'active') return null;
          return work(client);
        });
      }
      const load = async (frontier: string, successor: boolean) =>
        storage(async (client) => {
          const rows = await client.query<Retained>(
            successor ? replaySql : loadSql,
            successor
              ? [owner.partition, frontier, Math.max(0, request.inputLimit - cost.inputKeys)]
              : [owner.partition, frontier],
          );
          return rows.rows[0];
        });
      const prior = request.frontier === null ? undefined : await load(request.frontier, false);
      if (request.frontier !== null && !prior) return fail('changed');
      if (prior && (prior.binding !== signature || prior.capture !== captured || Number(prior.expires) <= now))
        return fail('changed');
      const deliver = (row: Retained): FacetPopulationPage => {
        // A retry with a smaller allowance cannot read/replay an oversized retained page for free.
        if ((row.replay_keys ?? row.subjects.length) + cost.inputKeys > request.inputLimit) return fail('unready');
        cost = plus(cost, { inputKeys: row.subjects.length, outputSlots: row.subjects.length });
        return {
          status: row.complete ? 'complete' : 'progress',
          observation: row.observation,
          subjects: row.subjects,
          frontier: row.frontier,
          cost,
        };
      };
      if (prior?.complete)
        return { status: 'complete', observation: prior.observation, subjects: [], frontier: prior.frontier, cost };
      if (prior) {
        const replay = await load(prior.frontier, true);
        if (replay) return deliver(replay);
      }
      const state = structuredClone(prior?.state ?? initial());
      let next = state;
      let subjects: Subject[] = [];
      const remaining = Math.min(256, request.inputLimit - cost.inputKeys);
      if (remaining < 1 || Date.now() >= context.deadline) return fail('unavailable');
      if (state.phase === 'keys') {
        const page = await keys.read(
          { partition: state.partition, after: state.after, inputLimit: remaining },
          context,
        );
        cost = plus(cost, page.cost);
        if (page.status !== 'eligible') return fail(page.status === 'identity_pending' ? 'unready' : 'unavailable');
        if (state.epoch !== null && state.epoch !== page.epoch) return fail('changed');
        if (state.base !== null && page.position < BigInt(state.base)) return fail('changed');
        next = { ...state, epoch: page.epoch, base: state.base ?? String(page.position), after: page.after };
        subjects = page.ids.map((subject) => ({ partition: state.partition, subject }));
        if (page.complete) {
          next.through = String(page.position);
          next.position = String(BigInt(next.base!) + 1n);
          next.phase = 'bridge';
          if (BigInt(next.position) > page.position) next = advanceHome(next);
        } else if (page.after === null || fingerprint(page.after) === fingerprint(state.after)) return fail('unready');
      } else if (state.phase === 'bridge' || state.phase === 'anchor') {
        const bridge = await withConnection(config.pool, async (client) => {
          await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
          try {
            const home = await readPartition(client, state.partition);
            cost = plus(cost, { dependencyPoints: 1 });
            if (!home || home.writeState !== 'active') return null;
            if (home.epoch !== state.epoch || home.position < BigInt(state.through!)) return 'changed';
            cost = plus(cost, { inputKeys: 1 });
            if (state.phase === 'anchor') {
              const route = routeOf(state.pending!);
              if (route === null || partitionOf(route) !== state.partition) return 'changed';
              const anchored = await client.query<{ id: string }>(anchorSql, [route, state.pending]);
              if (!anchored.rows.length) return 'unready';
              subjects = anchored.rows.map(({ id }) => ({ partition: state.partition, subject: id }));
              next = { ...state, phase: 'bridge', pending: null };
            } else {
              const result = await client.query<{
                epoch: number;
                event_count: number;
                type: string;
                subject: string | null;
              }>(bridgeSql, [state.partition, state.position, state.sequence]);
              const event = result.rows[0];
              if (
                !event ||
                event.epoch !== state.epoch ||
                (state.eventCount !== null && state.eventCount !== event.event_count)
              )
                return 'changed';
              const last = state.sequence + 1 === event.event_count;
              next = {
                ...state,
                position: last ? String(BigInt(state.position!) + 1n) : state.position,
                sequence: last ? 0 : state.sequence + 1,
                eventCount: last ? null : event.event_count,
              };
              // Reuse the ordinary subject-event convention consumed by search/indexer.ts.
              // Other product event subjects can name candidates, resources or foreign anchors.
              if (event.type.startsWith('com.rezics.subject.')) {
                const route = event.subject === null ? null : routeOf(event.subject);
                if (route === null || partitionOf(route) !== state.partition) return 'changed';
                next = { ...next, phase: 'anchor', pending: event.subject };
              }
            }
            if (next.phase === 'bridge' && BigInt(next.position!) > BigInt(next.through!)) next = advanceHome(next);
            return 'ok';
          } finally {
            await client.query('ROLLBACK');
          }
        });
        if (bridge === null) return fail('unavailable');
        if (bridge === 'changed') return fail('changed');
        if (bridge === 'unready') return fail('unready');
      }
      if (Date.now() >= context.deadline) return fail('unavailable');
      // Empty native home pages and finite bridge exhaustion are required before reaching seal.
      // The native observation above revalidates the SAME immutable consumer, not its latest ACK.
      const row: Retained = {
        frontier: randomUUID(),
        observation: prior?.observation ?? observed.start.observation,
        binding: signature,
        capture: captured,
        state: next,
        subjects,
        complete: state.phase === 'seal',
        expires: prior?.expires ?? String(now + lifetime),
      };
      const saved = await storage(async (client) => {
        const result = await client.query<Retained>(appendSql, [
          owner.partition,
          row.frontier,
          prior?.frontier ?? null,
          row.observation,
          signature,
          captured,
          JSON.stringify(next),
          JSON.stringify(subjects),
          row.complete,
          row.expires,
          owner.epoch,
        ]);
        cost = plus(cost, { frontierWrites: 1 });
        return result.rows[0];
      });
      if (saved === null || Date.now() >= context.deadline) return fail('unavailable');
      if (!saved) {
        // The winning successor is durable; a loser never publishes its discarded subjects.
        const winner = prior ? await load(prior.frontier, true) : undefined;
        return winner ? deliver(winner) : fail('changed');
      }
      cost = plus(cost, { outputSlots: subjects.length });
      return {
        status: row.complete ? 'complete' : 'progress',
        observation: row.observation,
        subjects,
        frontier: row.frontier,
        cost,
      };
    },
  };
};

export { createFacetPopulationSource } from './copy-work-application.ts';
