import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { anchorRoute, partitionOf, routeOf, newId } from '../../src/route/route.ts';
import { CREATE_SUBJECT } from '../../src/semantic/subject.ts';
import {
  createSubjectSourceKeyPages,
  readSubjectKeyPage,
  type SubjectSourceKeyCursor,
} from '../../src/semantic/subject-source-key-pages.ts';
import { assertGrowthAccessPaths, capture, checkGrowth, costOf, seed } from '../support/growth.ts';
import { capturedStep, fixture, readContext, type Fixture } from './support/public-filter-source.ts';

// Route fixture writes through the existing real HTTP/Auth/Access fixture. Searching idempotency
// inputs chooses a native home; it does not mint subjects, ready identities or coverage rows.
async function homeWriter(f: Fixture, partition: number, route?: number) {
  const prefix = randomUUID();
  let ordinal = 0;
  return async () => {
    for (;;) {
      const key = `${prefix}-${ordinal++}`;
      const actual = anchorRoute(f.config.routeKey, `${f.accounts.editor}\n${CREATE_SUBJECT}\n${key}`);
      if (partitionOf(actual) !== partition || (route !== undefined && actual !== route)) continue;
      const id = await f.create('schema:Book', {}, key);
      expect(routeOf(id)).toBe(actual);
      return id;
    }
  };
}

async function emptyHome(f: Fixture) {
  const result = await f.db.admin.query<{ partition_no: number }>(
    `SELECT p.partition_no FROM core.partition p WHERE p.write_state='active' AND p.epoch>0
     AND NOT EXISTS (SELECT 1 FROM semantic.subject s
       WHERE s.route>=p.partition_no*16 AND s.route<(p.partition_no+1)*16)
     ORDER BY p.partition_no DESC LIMIT 1`,
  );
  const home = result.rows[0];
  if (!home) throw new Error('Native key-page fixture needs an empty active home');
  return home.partition_no;
}

function cursor(id: string): SubjectSourceKeyCursor {
  const route = routeOf(id);
  if (route === null) throw new Error('Expected a native routed Subject key');
  return { route, id };
}

function ordered(ids: readonly string[]) {
  return [...ids].sort((a, b) => routeOf(a)! - routeOf(b)! || a.localeCompare(b));
}

test('native key-page boundaries 0/1/255/256/257 retain exact raw completeness and real owner positions with one checkout', async () => {
  const f = await fixture();
  try {
    const partition = await emptyHome(f);
    const write = await homeWriter(f, partition);
    const pool = f.db.openPool({ max: 1 });
    const pages = createSubjectSourceKeyPages(pool, f.config.routeKey, f.config.access);
    const ids: string[] = [];
    for (const size of [0, 1, 255, 256, 257]) {
      while (ids.length < size) ids.push(await write());
      const expected = ordered(ids);
      const owner = (
        await f.db.admin.query<{ epoch: number; position: string }>(
          'SELECT epoch,position::text FROM core.partition WHERE partition_no=$1',
          [partition],
        )
      ).rows[0]!;
      const measured = await capture(
        f.db,
        () => pages.read({ partition, after: null, inputLimit: 256 }, readContext()),
        { includeBackends: true },
      );
      const page = measured.value;
      expect(page.status).toBe('eligible');
      if (page.status !== 'eligible') throw new Error(page.status);
      expect(page.epoch).toBe(owner.epoch);
      expect(page.position).toBe(BigInt(owner.position));
      expect(page.ids).toEqual(expected.slice(0, 256));
      expect(page.cost.inputKeys).toBe(Math.min(size, 256));
      expect(page.complete).toBe(size < 256);
      expect(page.after).toEqual(size === 0 ? null : cursor(expected[Math.min(size, 256) - 1]!));
      const physical = costOf(measured.capture);
      expect(physical.rows).toBeLessThanOrEqual(64 + 16 * page.cost.inputKeys);
      expect(physical.blocks).toBeLessThanOrEqual(6 * (64 + 16 * page.cost.inputKeys));
      expect(physical.responseBytes).toBeDefined();
      expect(physical.responseBytes!).toBeLessThanOrEqual(4 * 1024 * 1024);
      expect(physical.failedStatements ?? {}).toEqual({});
      expect(new Set(measured.capture.statementBackends).size).toBe(1);
      if (size >= 256) {
        const measuredSuffix = await capture(
          f.db,
          () =>
            pages.read(
              {
                partition,
                after: page.after,
                inputLimit: 256,
              },
              readContext(),
            ),
          { includeBackends: true },
        );
        const suffix = measuredSuffix.value;
        expect(costOf(measuredSuffix.capture).rows).toBeLessThanOrEqual(64 + 16 * (size - 256));
        expect(suffix).toMatchObject({
          status: 'eligible',
          ids: expected.slice(256),
          complete: true,
          cost: { inputKeys: size - 256 },
        });
      }
    }
    const expected = ordered(ids);
    const deep = await capturedStep(f.db, () =>
      pages.read(
        {
          partition,
          after: cursor(expected[254]!),
          inputLimit: 1,
        },
        readContext(),
      ),
    );
    expect(deep).toMatchObject({
      status: 'eligible',
      ids: [expected[255]],
      after: cursor(expected[255]!),
      complete: false,
      cost: { inputKeys: 1 },
    });
    // Actual same-count substitution: reduce one original and create another through native
    // commands. Counts stay equal; complete current keys must detect both missing and extra IDs.
    await f.post(`/v1/subjects/${expected[0]}:hide`, { reason: 'Same-count native population change' });
    const replacement = await write();
    const changed: string[] = [];
    let after: SubjectSourceKeyCursor | null = null;
    for (;;) {
      const page = await pages.read({ partition, after, inputLimit: 256 }, readContext());
      if (page.status !== 'eligible') throw new Error(page.status);
      expect(page.cost.inputKeys).toBeLessThanOrEqual(256);
      changed.push(...page.ids);
      if (page.complete) break;
      expect(page.after).not.toEqual(after);
      after = page.after;
    }
    expect(changed).toHaveLength(expected.length);
    expect(changed).toEqual(ordered([...expected.slice(1), replacement]));
    expect(changed).not.toEqual(expected);
    // The fixed-cut Search compatibility bridge is independently pending. Current inventory
    // and its real position cannot be borrowed as older creation/change or request privacy proof.
    const owner = (
      await f.db.admin.query<{ epoch: number; position: string }>(
        'SELECT epoch,position::text FROM core.partition WHERE partition_no=$1',
        [partition],
      )
    ).rows[0]!;
    expect(
      await readSubjectKeyPage(
        {
          partition,
          epoch: owner.epoch,
          after: null,
          through: BigInt(owner.position),
          inputLimit: 256,
        },
        readContext(),
      ),
    ).toMatchObject({ status: 'unavailable', reason: 'source_pending' });
  } finally {
    await f.close();
  }
}, 600_000);

test('hidden raw prefixes, pending identity suffixes and owner moves cannot become complete empty key pages', async () => {
  const f = await fixture();
  try {
    const partition = await emptyHome(f);
    const write = await homeWriter(f, partition);
    const ids: string[] = [];
    for (let i = 0; i < 257; i++) ids.push(await write());
    const expected = ordered(ids);
    const pages = createSubjectSourceKeyPages(f.db.openPool({ max: 1 }), f.config.routeKey, f.config.access);
    for (const id of expected.slice(0, 255))
      await f.post(`/v1/subjects/${id}:hide`, { reason: 'Native hidden raw prefix' });
    const prefix = await capturedStep(f.db, () =>
      pages.read({ partition, after: null, inputLimit: 256 }, readContext()),
    );
    expect(prefix).toMatchObject({
      status: 'eligible',
      ids: [expected[255]],
      after: cursor(expected[255]!),
      complete: false,
      cost: { inputKeys: 256 },
    });
    const survivor = expected[256]!;
    const suffix = await capturedStep(f.db, () =>
      pages.read(
        {
          partition,
          after: cursor(expected[255]!),
          inputLimit: 256,
        },
        readContext(),
      ),
    );
    expect(suffix).toMatchObject({ status: 'eligible', ids: [survivor], complete: true, cost: { inputKeys: 1 } });
    // Native stale control-owner evidence, not a mocked ready flag. The complete accepted
    // prefix must be returned, while ALL 256 fetched rows (including unused suffix) are charged.
    const unknown = expected[1]!;
    await f.post(`/v1/subjects/${expected[0]}:restore`, { reason: 'Restore accepted prefix' });
    await f.post(`/v1/subjects/${unknown}:restore`, { reason: 'Restore pending input' });
    const original = (
      await f.db.admin.query<{ owner_epoch: number }>(
        'SELECT owner_epoch FROM semantic.identity_epoch_group WHERE partition_no=$1 AND terminal=$2',
        [partition, unknown],
      )
    ).rows[0]!;
    try {
      await f.db.admin.query(
        'UPDATE semantic.identity_epoch_group SET owner_epoch=owner_epoch+1 WHERE partition_no=$1 AND terminal=$2',
        [partition, unknown],
      );
      const accepted = await capturedStep(f.db, () =>
        pages.read({ partition, after: null, inputLimit: 256 }, readContext()),
      );
      expect(accepted).toMatchObject({
        status: 'eligible',
        ids: [expected[0]],
        after: cursor(expected[0]!),
        complete: false,
        cost: { inputKeys: 256 },
      });
      const pending = await capturedStep(f.db, () =>
        pages.read(
          {
            partition,
            after: cursor(expected[0]!),
            inputLimit: 256,
          },
          readContext(),
        ),
      );
      expect(pending).toMatchObject({
        status: 'identity_pending',
        after: cursor(expected[0]!),
        cost: { inputKeys: 256 },
      });
    } finally {
      await f.db.admin.query(
        'UPDATE semantic.identity_epoch_group SET owner_epoch=$3 WHERE partition_no=$1 AND terminal=$2',
        [partition, unknown, original.owner_epoch],
      );
    }
    const owner = (
      await f.db.admin.query<{ write_state: string }>('SELECT write_state FROM core.partition WHERE partition_no=$1', [
        partition,
      ])
    ).rows[0]!;
    try {
      await f.db.admin.query("UPDATE core.partition SET write_state='moved' WHERE partition_no=$1", [partition]);
      const moved = await capture(f.db, () => pages.read({ partition, after: null, inputLimit: 256 }, readContext()), {
        includeBackends: true,
      });
      expect(costOf(moved.capture).rows).toBeLessThanOrEqual(64);
      expect(moved.value).toMatchObject({ status: 'unavailable', reason: 'moved' });
    } finally {
      await f.db.admin.query('UPDATE core.partition SET write_state=$2 WHERE partition_no=$1', [
        partition,
        owner.write_state,
      ]);
    }
    expect(await pages.read({ partition, after: null, inputLimit: 256 }, { deadline: Date.now() - 1 })).toMatchObject({
      status: 'unavailable',
      reason: 'deadline',
    });
  } finally {
    await f.close();
  }
}, 600_000);

test('fixed deep key-page work stays bounded at 64/512/4096 unrelated subjects and independent history', async () => {
  const f = await fixture();
  try {
    const partition = await emptyHome(f);
    // Keep the measured native window at the highest route. Growing lower keys exercise a
    // real deep seek, rather than increasing output size or putting a limit after a scan.
    const write = await homeWriter(f, partition, partition * 16 + 15);
    const ids: string[] = [];
    for (let i = 0; i < 257; i++) ids.push(await write());
    const expected = ordered(ids);
    const pages = createSubjectSourceKeyPages(f.db.openPool({ max: 1 }), f.config.routeKey, f.config.access);
    const boundary = await (await homeWriter(f, partition, partition * 16 + 13))();
    const unrelated = await f.create('schema:Book');
    for (const axis of ['subjects', 'history']) {
      const report = await checkGrowth(f.db, {
        name: `rebuild-only native Source deep keys independent ${axis}`,
        scales: [64, 512, 4096],
        bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
        byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
        includeBackends: true,
        async grow(database, scale, previous) {
          if (axis === 'subjects')
            await seed(
              database,
              {
                name: `source-key-page-unrelated-${unrelated}`,
                hotPartition: partition,
                rows: ({ route, hot }) => ({
                  'semantic.subject': [
                    {
                      route: hot ? partition * 16 : route,
                      subject_id: newId(hot ? partition * 16 : route),
                      type: 'schema:Book',
                      recorded_transaction_id: randomUUID(),
                      current_release: f.meaning.digest,
                    },
                  ],
                }),
              },
              { from: previous, to: scale },
            );
          if (axis === 'history')
            await seed(
              database,
              {
                name: `source-key-page-history-${unrelated}`,
                hotPartition: partition,
                rows: ({ ordinal }) => ({
                  'semantic.revision': [
                    {
                      route: routeOf(unrelated)!,
                      subject_id: unrelated,
                      revision: ordinal + 2,
                      kind: 'propose',
                      release: f.meaning.digest,
                      recorded_transaction_id: randomUUID(),
                    },
                  ],
                }),
              },
              { from: previous, to: scale },
            );
        },
        async operation() {
          const page = await pages.read({ partition, after: cursor(expected[0]!), inputLimit: 256 }, readContext());
          expect(page.status).toBe('eligible');
          if (page.status !== 'eligible') throw new Error(page.status);
          expect(page.ids).toEqual(expected.slice(1));
          expect(page.cost.inputKeys).toBe(256);
          expect(page.complete).toBe(false);
          expect(page.after).toEqual(cursor(expected[256]!));
          expect(page.epoch).toBeGreaterThan(0);
          expect(typeof page.position).toBe('bigint');
        },
      });
      expect(report.samples.map(({ scale }) => scale)).toEqual([64, 512, 4096]);
      assertGrowthAccessPaths(`Source key-page ${axis}`, report.samples, [
        'semantic.subject',
        'semantic.redirect',
        'semantic.identity_epoch_mapping',
        'semantic.identity_epoch_group',
        'semantic.identity_epoch_dirty',
        'core.partition',
      ]);
      if (axis === 'subjects')
        expect(report.samples[2]!.relationSizes['semantic.subject']?.relpages).toBeGreaterThan(8);
      for (const sample of report.samples)
        for (const backends of sample.backendRepetitions) expect(backends).toHaveLength(1);
      // No SQL classification, capture filtering or foreign-pool exemption. Shared checkGrowth
      // retains every statement, buffer, removed row, byte and failure.
      for (const sample of report.samples)
        for (const work of sample.repetitions) {
          expect(work.rows).toBeLessThanOrEqual(64 + 16 * 256);
          expect(work.blocks).toBeLessThanOrEqual(6 * (64 + 16 * 256));
          expect(work.failedStatements ?? {}).toEqual({});
          expect(work.requestBytes).toBeDefined();
          expect(work.responseBytes).toBeDefined();
          expect(work.responseBytes!).toBeLessThanOrEqual(4 * 1024 * 1024);
          expect(work.statements).toBeLessThanOrEqual(16);
        }
    }
    // A later lower-route creation is genuinely absent from the old suffix but present on a
    // fresh current traversal. Retaining a cursor is not a creation/change coverage bridge.
    const lower = await (await homeWriter(f, partition, partition * 16 + 14))();
    const current = await capturedStep(f.db, () =>
      pages.read(
        {
          partition,
          after: cursor(boundary),
          inputLimit: 1,
        },
        readContext(),
      ),
    );
    expect(current).toMatchObject({ status: 'eligible', ids: [lower], complete: false });
  } finally {
    await f.close();
  }
}, 600_000);

test('native many-home inventories retain each actual epoch and position without hydrating subjects or claiming fixed-cut coverage', async () => {
  const f = await fixture();
  try {
    const pages = createSubjectSourceKeyPages(f.db.openPool({ max: 1 }), f.config.routeKey, f.config.access);
    const ids = new Map<number, string>();
    while (ids.size < 16) {
      const id = await f.create('schema:Book');
      ids.set(partitionOf(routeOf(id)!), id);
    }
    for (const [partition, id] of ids) {
      const before =
        (
          await f.db.admin.query<{ route: number; id: string }>(
            `SELECT route,subject_id::text id FROM semantic.subject
         WHERE route >= $1*16 AND (route,subject_id)<($2,$3::uuid)
         ORDER BY route DESC,subject_id DESC LIMIT 1`,
            [partition, routeOf(id), id],
          )
        ).rows[0] ?? null;
      const page = await capturedStep(f.db, () =>
        pages.read({ partition, after: before, inputLimit: 1 }, readContext()),
      );
      expect(page).toMatchObject({
        status: 'eligible',
        ids: [id],
        after: cursor(id),
        complete: false,
        cost: { inputKeys: 1 },
      });
      const owner = (
        await f.db.admin.query<{ epoch: number; position: string }>(
          'SELECT epoch,position::text FROM core.partition WHERE partition_no=$1',
          [partition],
        )
      ).rows[0]!;
      expect(page).toMatchObject({ epoch: owner.epoch, position: BigInt(owner.position) });
    }
  } finally {
    await f.close();
  }
});
