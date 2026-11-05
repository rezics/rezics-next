import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { systemClock } from '../../src/clock.ts';
import { createOpenSearch } from '../../src/search/opensearch.ts';
import { subjectConsumer } from '../../src/search/runner.ts';
import { publicFilterSource } from '../../src/semantic/public-filter-source.ts';
import { createPublicFilterSourceBinding } from '../../src/semantic/public-filter-source-binding.ts';
import {
  readPublicFilterConsumerCustody,
  readPublicFilterRepairSettlement,
  decodePublicFilterNativeState,
} from '../../src/search/public-filter-custody.ts';
import type {
  PublicFilterConsumerJob,
  PublicFilterQueriedObservation,
} from '../../src/search/public-filter-consumer-contract.ts';
import type { NativePublicFilterRepairSettlement } from '../../src/search/public-filter-custody-contract.ts';
import { fixture, statement, home } from '../semantic/support/public-filter-source.ts';
import { createPublicFilterConsumerFixture } from './support/public-filter-consumer.ts';

const context = () => ({ deadline: Date.now() + 60_000 });
// A record locator alone is never caller-constructible native settlement evidence.
// @ts-expect-error The private producer brand is owned only by the canonical custody type module.
const forged: NativePublicFilterRepairSettlement = { id: randomUUID() };
void forged;

async function setup(populate = true) {
  const f = await fixture();
  const source = publicFilterSource(f.config);
  let author: string | undefined;
  let book: string | undefined;
  if (populate) {
    author = await f.create();
    book = await f.create('schema:Book', { 'schema:author': [statement('schema:author', author)] });
  }
  const url = process.env.OPENSEARCH_URL;
  if (!url) throw new Error('OPENSEARCH_URL must name the configured native engine');
  const search = createOpenSearch(url);
  const native = await createPublicFilterConsumerFixture({
    pool: f.db.pool,
    source,
    binding: createPublicFilterSourceBinding(f.db.pool, f.config.routeKey, f.config.access),
    search,
    clock: systemClock,
    context: context(),
    meaning: f.meaning,
  });
  async function capture() {
    const plan = { sort: 'id' as const, size: 20, text: undefined, filterDocument: { type: { in: ['schema:Book'] } } };
    for (let step = 0; step < 256; step++) {
      const result = await native.operations.capture({ plan, snapshot: 'pit' }, context());
      if (result.status === 'captured') return result;
      expect(result.status).toBe('preparing');
      if (result.status !== 'preparing') throw new Error(`Native capture ${result.status}`);
      await native.operations.repairStep(result.repair, context());
    }
    throw new Error('Finite native bootstrap did not capture');
  }
  return {
    f,
    source,
    author,
    book,
    search,
    native,
    capture,
    read: (queried: PublicFilterQueriedObservation, execution: string) =>
      readPublicFilterRepairSettlement(f.db.pool, { queried, execution }, context()),
    async close() {
      try {
        await native.close();
      } finally {
        await f.close();
      }
    },
  };
}
type Native = Awaited<ReturnType<typeof setup>>;

async function execute(n: Native) {
  const captured = await n.capture();
  const query = await n.native.operations.query(captured.queried, context());
  expect(query.status).toBe('queried');
  if (query.status !== 'queried') throw new Error(`Native query ${query.status}`);
  const retained = await readPublicFilterConsumerCustody(
    n.f.db.pool,
    { queried: query.queried, execution: query.execution },
    context(),
  );
  expect(retained.status).toBe('found');
  if (retained.status !== 'found' || !retained.execution) throw new Error('Missing actual native execution');
  return { captured, query, retained };
}

async function finish(
  n: Native,
  job: PublicFilterConsumerJob,
  queried: PublicFilterQueriedObservation,
  execution: string,
) {
  // Source owns a scalar frontier across its finite native homes. This is executable runtime work,
  // never an empty-page/count/lease shortcut or a fabricated Source receipt in this Search test.
  for (let step = 0; step < 20_000; step++) {
    const result = await n.native.operations.repairStep(job, context());
    if (result.status === 'progress') continue;
    const settled = await n.read(queried, execution);
    if (settled.status === 'settled') return settled;
    throw new Error(`Native repair could not close: ${result.status}/${settled.status}`);
  }
  throw new Error('Finite native repair did not close its retained Source window');
}

async function untilDispatch(n: Native, job: PublicFilterConsumerJob, reached: Promise<unknown>) {
  // The existing fixture holds a real engine request. Preserve that handle instead of polling a process.
  let entered = false;
  void reached.then(() => {
    entered = true;
  });
  let pending: Promise<unknown> | undefined;
  for (let step = 0; step < 20_000; step++) {
    pending = n.native.operations.repairStep(job, context());
    const next = await Promise.race([reached.then(() => 'dispatch' as const), pending]);
    if (next === 'dispatch' || entered) return pending;
    expect((next as { status: string }).status).toBe('progress');
  }
  throw new Error('Actual native repair never dispatched');
}

test('native repair settlement guards late dispatch, lost wait_for response, original execution and final writer fence', async () => {
  const n = await setup();
  try {
    const { captured, query, retained } = await execute(n);
    expect((await n.read(query.queried, query.execution)).status).not.toBe('settled');
    const gate = n.native.arm('refresh', 'disconnect_after');
    const dispatch = untilDispatch(n, captured.repair, gate.reached);
    try {
      expect(
        await Promise.race([
          gate.reached,
          dispatch.then(() => {
            throw new Error('Repair ended before the native completion hold');
          }),
        ]),
      ).toEqual({ kind: 'bulk_wait_for', stage: 'after_response' });
      // Engine visibility has happened, but producer custody has not received native completion.
      expect((await n.read(query.queried, query.execution)).status).not.toBe('settled');
      const uncertain = await n.f.db.pool.query(
        `SELECT writer_token,dispatch_state FROM search.identity_writer
        WHERE physical_target=$1 AND dispatch_state='dispatched'`,
        [n.native.physicalTarget],
      );
      expect(uncertain.rows.length).toBeGreaterThan(0);
      expect(uncertain.rows.every((row) => row.writer_token !== null)).toBe(true);
    } finally {
      gate.release();
    }
    await dispatch;
    // Recover only the retained locator, action and own-home native version after the lost response.
    const settled = await finish(n, captured.repair, query.queried, query.execution);
    expect(settled.execution).toEqual(retained.execution!);
    expect(settled.queried).toEqual(query.queried);
    expect(settled.definition).toEqual(retained.definition);
    expect(settled.settlement.id).toBeString();
    expect(
      await readPublicFilterConsumerCustody(
        n.f.db.pool,
        { queried: query.queried, execution: query.execution },
        context(),
      ),
    ).toMatchObject({ covered: retained.covered });
    expect((await n.read(query.queried, randomUUID())).status).not.toBe('settled');
    expect(
      (
        await n.read(
          { ...query.queried, consumer: { ...query.queried.consumer, projectionGeneration: 'unretained-generation' } },
          query.execution,
        )
      ).status,
    ).not.toBe('settled');

    // A genuine ordinary writer enrollment is a final fence even though the previous repair was visible.
    const { createSearchWriterGuard } = await import('../../src/search/writer-guard.ts');
    const { createRatedSubjectSource } = await import('../../src/search/rated-source.ts');
    const { subjectListingSource } = await import('../../src/library/listing-counts.ts');
    const match = /^(.*)subjects-g([1-9][0-9]*)$/.exec(n.native.physicalTarget)!;
    const writer = createSearchWriterGuard({
      pool: n.f.db.pool,
      search: n.native.transport,
      index: n.native.physicalTarget,
      consumer: subjectConsumer(match[1]!, Number(match[2])),
      source: createRatedSubjectSource(n.f.db.pool, n.f.config.routeKey).source,
      listing: subjectListingSource(n.f.db.pool),
    });
    const pending = n.native.arm('write');
    const late = writer.write(home(n.book!), [n.book!], 0n);
    try {
      await Promise.race([
        pending.reached,
        late.then(() => {
          throw new Error('Ordinary writer ended before the native dispatch hold');
        }),
      ]);
      expect((await n.read(query.queried, query.execution)).status).not.toBe('settled');
    } finally {
      pending.release();
    }
    await late;
    // Changed current winner/enrollment cannot inherit the old repair's settlement.
    expect((await n.read(query.queried, query.execution)).status).not.toBe('settled');
  } finally {
    await n.close();
  }
}, 600_000);

test('native settlement refuses uncertain writes before send and refuses physical replacement after recovery', async () => {
  const n = await setup();
  try {
    const { captured, query } = await execute(n);
    const gate = n.native.arm('write', 'disconnect_before');
    const pending = untilDispatch(n, captured.repair, gate.reached);
    try {
      expect(
        await Promise.race([
          gate.reached,
          pending.then(() => {
            throw new Error('Repair ended before the native dispatch hold');
          }),
        ]),
      ).toEqual({ kind: 'bulk_wait_for', stage: 'before_send' });
      expect((await n.read(query.queried, query.execution)).status).not.toBe('settled');
    } finally {
      gate.release();
    }
    await pending;
    expect((await n.read(query.queried, query.execution)).status).not.toBe('settled');
    await finish(n, captured.repair, query.queried, query.execution);
    await n.native.recreate();
    expect((await n.read(query.queried, query.execution)).status).not.toBe('settled');
  } finally {
    await n.close();
  }
}, 600_000);

test('zero repair effects require a retained complete Source window and native final fence under the original cut', async () => {
  const n = await setup(false);
  try {
    const { captured, query, retained } = await execute(n);
    expect(query.result.hits).toEqual([]);
    // The actual empty fetched response is insufficient; Source window closure is still missing.
    expect((await n.read(query.queried, query.execution)).status).not.toBe('settled');
    const settled = await finish(n, captured.repair, query.queried, query.execution);
    expect(settled.execution).toEqual(retained.execution!);
    const last = (
      await n.f.db.pool.query(
        `SELECT intent FROM search.public_filter_repair_page
      WHERE partition_no=$1 AND observation=$2 AND execution=$3 ORDER BY ordinal DESC LIMIT 1`,
        [Number(query.queried.snapshot.observation.split(':')[0]), query.queried.snapshot.observation, query.execution],
      )
    ).rows[0];
    const intent = decodePublicFilterNativeState<{ sourceStep: string; predecessor: string | null }>(last.intent);
    const step = (
      await n.f.db.pool.query(
        `SELECT complete,predecessor::text FROM semantic.public_filter_repair_step
      WHERE partition_no=0 AND bootstrap=$1 AND execution=$2 AND step=$3`,
        [retained.covered.observation.slice(2), query.execution, intent.sourceStep],
      )
    ).rows[0];
    expect(step).toEqual({ complete: true, predecessor: intent.predecessor });
    const second = await n.read(query.queried, query.execution);
    expect(second.status).toBe('settled');
    if (second.status === 'settled') expect(second.settlement.id).toBe(settled.settlement.id);
    // A genuinely newer capture cannot replace the old immutable bootstrap cut.
    const newer = await n.capture();
    expect(newer.queried.snapshot.observation).not.toBe(query.queried.snapshot.observation);
    expect(
      await readPublicFilterConsumerCustody(
        n.f.db.pool,
        { queried: query.queried, execution: query.execution },
        context(),
      ),
    ).toMatchObject({ covered: retained.covered });
    const use = await n.read(query.queried, query.execution);
    expect(use.status).toBe('settled');
    expect(use.cost.engineRequests).toBeGreaterThan(0);
  } finally {
    await n.close();
  }
}, 600_000);
