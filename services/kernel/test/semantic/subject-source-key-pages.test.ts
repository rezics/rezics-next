import { expect, test } from 'bun:test';
import { createSubjectSourceKeyPages } from '../../src/semantic/subject-source-key-pages.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { fixture, readContext } from './support/public-filter-source.ts';

test('rebuild-only Source key pages exactly enumerate eligible native population within256 raw keys', async () => {
  const f = await fixture();
  try {
    const ids = [await f.create(), await f.create(), await f.create()];
    const hidden = ids[0]!;
    await f.post(`/v1/subjects/${hidden}:hide`, { reason: 'Hidden rebuild input' });
    // Reuse the existing instrumented pool surface with one checkout available.
    const pool = f.db.openPool({ max: 1 });
    const pages = createSubjectSourceKeyPages(pool, f.config.routeKey, f.config.access);
    for (const partition of new Set(ids.map((id) => partitionOf(routeOf(id)!)))) {
      const raw = (
        await f.db.admin.query(
          `SELECT s.route,s.subject_id::text id,s.visibility,
          (SELECT target FROM semantic.redirect WHERE route=s.route AND subject_id=s.subject_id ORDER BY sequence DESC LIMIT 1) redirect
         FROM semantic.subject s WHERE s.route >= $1*16 AND s.route < ($1+1)*16 ORDER BY s.route,s.subject_id`,
          [partition],
        )
      ).rows;
      const expected = raw.filter((row) => row.visibility === 'visible' && row.redirect === null).map((row) => row.id);
      const actual: string[] = [];
      let after: { route: number; id: string } | null = null;
      let completed = false;
      for (let step = 0; step <= raw.length; step++) {
        const page = await pages.read({ partition, after, inputLimit: 1 }, readContext());
        expect(page.status).toBe('eligible');
        if (page.status !== 'eligible') throw new Error(`Native inventory ${page.status}`);
        expect(page.epoch).toBeGreaterThan(0);
        expect(typeof page.position).toBe('bigint');
        expect(page.cost.inputKeys).toBeLessThanOrEqual(1);
        actual.push(...page.ids);
        if (page.complete) {
          completed = true;
          break;
        }
        expect(page.after).not.toEqual(after);
        after = page.after;
      }
      expect(completed).toBe(true);
      expect(actual).toEqual(expected);
      expect(actual).not.toContain(hidden);
      // An empty suffix is actual native coverage, with its retained owner metadata.
      const last = raw.at(-1)!;
      const empty = await pages.read(
        { partition, after: { route: last.route, id: last.id }, inputLimit: 256 },
        readContext(),
      );
      expect(empty).toMatchObject({ status: 'eligible', ids: [], complete: true, cost: { inputKeys: 0 } });
    }
  } finally {
    await f.close();
  }
});

test('key pages expose identity-pending or unavailable instead of false empty', async () => {
  const f = await fixture();
  try {
    const id = await f.create();
    const route = routeOf(id)!;
    const partition = partitionOf(route);
    const pages = createSubjectSourceKeyPages(f.db.pool, f.config.routeKey, f.config.access);
    const original = (
      await f.db.admin.query(
        'SELECT owner_epoch FROM semantic.identity_epoch_group WHERE partition_no=$1 AND terminal=$2',
        [partition, id],
      )
    ).rows[0]!;
    // A native stale control-owner epoch cannot become an empty public range.
    try {
      await f.db.admin.query(
        'UPDATE semantic.identity_epoch_group SET owner_epoch=owner_epoch+1 WHERE partition_no=$1 AND terminal=$2',
        [partition, id],
      );
      // Seek immediately before this actual key without inventing a routable sentinel.
      const before =
        (
          await f.db.admin.query(
            'SELECT route,subject_id::text id FROM semantic.subject WHERE route >= $1*16 AND (route,subject_id)<($2,$3::uuid) ORDER BY route DESC,subject_id DESC LIMIT 1',
            [partition, route, id],
          )
        ).rows[0] ?? null;
      const pending = await pages.read({ partition, after: before, inputLimit: 1 }, readContext());
      expect(pending).toMatchObject({ status: 'identity_pending', after: before, cost: { inputKeys: 1 } });
    } finally {
      await f.db.admin.query(
        'UPDATE semantic.identity_epoch_group SET owner_epoch=$3 WHERE partition_no=$1 AND terminal=$2',
        [partition, id, original.owner_epoch],
      );
    }
    const owner = (await f.db.admin.query('SELECT write_state FROM core.partition WHERE partition_no=$1', [partition]))
      .rows[0]!;
    try {
      await f.db.admin.query("UPDATE core.partition SET write_state='moved' WHERE partition_no=$1", [partition]);
      expect(await pages.read({ partition, after: null, inputLimit: 256 }, readContext())).toMatchObject({
        status: 'unavailable',
        reason: 'moved',
      });
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
    await expect(pages.read({ partition, after: null, inputLimit: 257 }, readContext())).rejects.toThrow();
    await expect(
      pages.read({ partition, after: { route: route + 16, id }, inputLimit: 1 }, readContext()),
    ).rejects.toThrow();
  } finally {
    await f.close();
  }
});
