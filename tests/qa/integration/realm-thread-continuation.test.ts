import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Pool } from 'pg';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { bestKey } from '../../../services/main/src/modules/feed/ranking.ts';
import { REALM_THREAD_COST } from '../../../services/main/src/modules/realm-reply/thread-contract.ts';
import { WorkReadUnavailable, type WorkReadSession } from '../../../services/main/src/modules/work/read-session.ts';
import {
  RealmReplyThreadStore,
  type ThreadSibling,
  type ThreadSiblingKey,
} from '../../../services/main/src/modules/realm-reply/thread-store.ts';
import { cloneQaOwnerDatabases } from '../support/fake-delivery.ts';

const native = (n: number) =>
  `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const sorts = ['best', 'top', 'new'] as const;
type Sort = (typeof sorts)[number];
interface Plan {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Index Cond'?: string;
  'Actual Rows': number;
  'Actual Loops': number;
  'Rows Removed by Filter'?: number;
  'Rows Removed by Index Recheck'?: number;
  Plans?: Plan[];
}
const nodes = (plan: Plan): Plan[] => [plan, ...(plan.Plans ?? []).flatMap(nodes)];
const examined = (plan: Plan) =>
  (plan['Actual Rows'] +
    (plan['Rows Removed by Filter'] ?? 0) +
    (plan['Rows Removed by Index Recheck'] ?? 0)) *
  plan['Actual Loops'];
const key = ({ rank, time, placement }: ThreadSiblingKey): ThreadSiblingKey => ({ rank, time, placement });

interface Reference {
  reply: string;
  placement: string;
  parent: string;
  score: number;
  time: number;
  active: boolean;
}
function ordered(references: readonly Reference[], sort: Sort): ThreadSiblingKey[] {
  return references.filter((row) => row.active).map((row) => ({
    rank: sort === 'best' ? -bestKey(row.score, row.time) : sort === 'top' ? -row.score : 0,
    time: String(-row.time),
    placement: row.placement,
  })).sort((a, b) => a.rank - b.rank || Number(a.time) - Number(b.time)
    || a.placement.localeCompare(b.placement));
}
function expectKeys(actual: readonly ThreadSiblingKey[], expected: readonly ThreadSiblingKey[]) {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((row, index) => {
    expect({ time: row.time, placement: row.placement }).toEqual({
      time: expected[index]!.time, placement: expected[index]!.placement,
    });
    // PostgreSQL's numeric time division and JS floating division can differ
    // at the last bit without changing this fixture's score/time ordering.
    expect(row.rank).toBeCloseTo(expected[index]!.rank, 8);
  });
}

test('Realm continuations reach sibling 192 and branch 33 with bounded indexed reads after a removed anchor', async () => {
  const runId = Bun.env.REZICS_QA_RUN_ID;
  if (!runId) throw new Error('Run through goalctl test');
  const databases = await cloneQaOwnerDatabases(runId, ['access', 'content']);
  const access = new Pool({ connectionString: databases.urls.access, max: 2 });
  const content = new Pool({ connectionString: databases.urls.content, max: 2 });
  const epoch = randomUUID(), realm = native(90000), work = native(90001);
  const evidence: { name: string; statement: string; plan: Plan }[] = [];
  let statements: { text: string; values: unknown[] }[] = [];
  // Explain the statements the production adapter actually executes, rather
  // than a second hand-written query that could drift away from the read.
  const observed = { query: (text: string, values: unknown[] = []) => {
    statements.push({ text, values });
    return access.query(text, values);
  } } as unknown as Pool;
  const store = new RealmReplyThreadStore(content, observed);
  const insert = async (references: readonly Reference[]) => {
    await access.query(`INSERT INTO access.realm_thread_reference
      (data_epoch,realm,reply,placement,parent,thread,work,occurred_at,activity_at,score,active)
      SELECT $1,$2,r.reply,r.placement,r.parent,r.parent,$3,
        to_timestamp(r.time/1000.0),to_timestamp(r.time/1000.0),r.score,r.active
      FROM jsonb_to_recordset($4::jsonb)
        AS r(reply text,placement text,parent text,time bigint,score integer,active boolean)`,
    [epoch, realm, work, JSON.stringify(references)]);
  };
  const page = async (name: string, parent: string, sort: Sort, limit: number,
    after?: ThreadSiblingKey, explain = true): Promise<ThreadSibling[]> => {
    statements = [];
    const rows = await store.siblingPage(epoch, realm, parent, sort, limit, after);
    expect(rows.length, name).toBeLessThanOrEqual(limit + 1);
    if (explain) {
      expect(statements.length, name).toBeGreaterThan(0);
      for (const statement of statements) {
        const plan = (await access.query(
          `EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON,TIMING OFF) ${statement.text}`,
          statement.values,
        )).rows[0]['QUERY PLAN'][0].Plan as Plan;
        evidence.push({ name, statement: statement.text, plan });
        const all = nodes(plan), references = all.filter(
          (node) => node['Relation Name'] === 'realm_thread_reference');
        expect(references.length, name).toBeGreaterThan(0);
        expect(all.some((node) => ['Seq Scan', 'Sort', 'Hash', 'Hash Join'].includes(
          node['Node Type'])), name).toBe(false);
        expect(references.every((node) => node['Index Name']
          && node['Index Cond']?.includes('data_epoch')
          && node['Index Cond']?.includes('realm')
          && node['Index Cond']?.includes('parent')), name).toBe(true);
        // One limited drive and at most one indexed child-existence result
        // for each candidate. Denied/inactive and earlier siblings cost no scan.
        expect(references.reduce((sum, node) => sum + examined(node), 0), name)
          .toBeLessThanOrEqual(2 * (limit + 1));
      }
    }
    return rows;
  };
  const baseTime = Date.UTC(2026, 0, 1);
  const seekAnchor = async (row: ThreadSiblingKey, sort: Sort): Promise<ThreadSiblingKey> => {
    if (sort !== 'best') return row;
    const canonical = (await access.query<{ rank: number }>(`SELECT
      access.realm_reply_best(score,occurred_at) AS rank FROM access.realm_thread_reference
      WHERE data_epoch=$1 AND realm=$2 AND placement=$3`, [epoch, realm, row.placement])).rows[0]!;
    return { ...row, rank: canonical.rank };
  };
  const references = (parent: string, first: number, count: number): Reference[] =>
    Array.from({ length: count }, (_, index) => ({
      reply: native(first + index), placement: native(first + index + 100000), parent,
      // Deliberate score/time ties exercise the placement's final seek key.
      score: index % 5 - 2, time: baseTime + Math.floor(index / 16) * 1000, active: true,
    }));
  try {
    await migrateContent(content);
    const source = (await content.query<{ data_epoch: string; sequence: string }>(
      'SELECT data_epoch::text,sequence::text FROM content.owner_control WHERE singleton')).rows[0]!;
    await access.query(`INSERT INTO access.realm_thread_checkpoint
      (data_epoch,content_epoch,content_sequence,sequence,after_event) VALUES($1,$2,$3,7,'￿')`,
    [epoch, source.data_epoch, source.sequence]);
    await access.query(`INSERT INTO access.realm_thread_dirty(data_epoch,kind,resource)
      SELECT $1,'population','pending-'||id FROM generate_series(1,10000) AS id`, [epoch]);
    await access.query('ANALYZE access.realm_thread_dirty');
    const session = { position: { dataEpoch: epoch, sequence: '7' } } as WorkReadSession;
    statements = [];
    await store.assertThreadProjection(session);
    for (const statement of statements) {
      const plan = (await access.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON,TIMING OFF) ${statement.text}`,
        statement.values)).rows[0]['QUERY PLAN'][0].Plan as Plan;
      evidence.push({ name: 'projection-population-backlog', statement: statement.text, plan });
      const pending = nodes(plan).filter(node => node['Relation Name'] === 'realm_thread_dirty');
      expect(pending).toHaveLength(1);
      expect(pending[0]!['Index Name']).toBe('realm_reply_projection_pending');
      expect(pending.reduce((sum, node) => sum + examined(node), 0)).toBe(0);
    }
    await access.query(`INSERT INTO access.realm_thread_dirty(data_epoch,kind,resource)
      VALUES($1,'reply','unprojected-reply')`, [epoch]);
    await expect(store.assertThreadProjection(session)).rejects.toBeInstanceOf(WorkReadUnavailable);
    await access.query(`DELETE FROM access.realm_thread_dirty WHERE data_epoch=$1 AND kind='reply'`, [epoch]);
    await content.query('UPDATE content.owner_control SET sequence=sequence+1 WHERE singleton');
    await expect(store.assertThreadProjection(session)).rejects.toBeInstanceOf(WorkReadUnavailable);

    const focus = native(90002), wide = native(90003), inactive = native(90004);
    const siblings = references(focus, 1, 192), large = references(wide, 1000, 10000);
    // The inactive prefix shares the same parent, so a request cannot hide a
    // full-population scan behind a small final LIMIT.
    const noise = references(wide, 20000, 10000).map((row) => ({ ...row, active: false }));
    const leaders = [...new Set(sorts.map((sort) => ordered(siblings, sort)[0]!.placement))]
      .map((placement) => siblings.find((row) => row.placement === placement)!.reply);
    // A visible leaf can have a large retired child population. Its existence
    // probe must seek active children rather than filter all historical ones.
    const retiredChildren = leaders.flatMap((parent, index) =>
      references(parent, 80000 + index * 2000, 1000).map((row) => ({ ...row, active: false })));
    await insert([...siblings, ...large, ...noise,
      ...retiredChildren,
      ...references(inactive, 40000, 1000).map((row) => ({ ...row, active: false }))]);
    await access.query('ANALYZE access.realm_thread_reference');
    for (const sort of sorts) {
      const expected = ordered(siblings, sort);
      const first = await page(`192-${sort}-first`, focus, sort, REALM_THREAD_COST.replies);
      expectKeys(first, expected);
      expect(first.every((row) => !row.hasChildren)).toBe(true);
      const shown = first.slice(0, REALM_THREAD_COST.replies);
      const next = await page(`192-${sort}-continued`, focus, sort, REALM_THREAD_COST.replies,
        key(shown.at(-1)!));
      expectKeys(next, expected.slice(REALM_THREAD_COST.replies));
      expect(new Set([...shown, ...next].map((row) => row.reply)).size).toBe(192);
      expect(await page(`inactive-${sort}`, inactive, sort, 20)).toEqual([]);

      const all = ordered(large, sort);
      expectKeys(await page(`10000-${sort}-first`, wide, sort, 20), all.slice(0, 21));
      expectKeys(await page(`10000-${sort}-middle`, wide, sort, 191,
        await seekAnchor(all[4999]!, sort)), all.slice(5000, 5192));
      expectKeys(await page(`10000-${sort}-end`, wide, sort, 20,
        await seekAnchor(all[9998]!, sort)), all.slice(9999));
    }

    for (const [index, sort] of sorts.entries()) {
      const parent = native(91000 + index), original = references(parent, 50000 + index * 1000, 192);
      await insert(original);
      const first = await page(`anchor-${sort}-first`, parent, sort, 20, undefined, false);
      const anchor = first[19]!, saved = key(anchor);
      const beforeDelete = ordered(original, sort);
      await access.query(`DELETE FROM access.realm_thread_reference
        WHERE data_epoch=$1 AND realm=$2 AND reply=$3`, [epoch, realm, anchor.reply]);
      // Removing the saved row does not erase its tuple or shift a subsequent
      // seek as OFFSET would; the continuation never resolves the anchor ID.
      const afterDelete = await page(`anchor-${sort}-deleted`, parent, sort, 20, saved);
      expectKeys(afterDelete, beforeDelete.slice(20, 41));

      const newer = { ...original[0]!, reply: native(60000 + index * 2),
        placement: native(160000 + index * 2), score: 1000, time: baseTime + 1000000 };
      const older = { ...original[0]!, reply: native(60001 + index * 2),
        placement: native(160001 + index * 2), score: -1000, time: baseTime - 1000000 };
      await insert([newer, older]);
      const current = ordered([...original.filter((row) => row.reply !== anchor.reply), newer, older], sort);
      const compare = (row: ThreadSiblingKey) => (Math.abs(row.rank - saved.rank) < 1e-8
        ? 0 : row.rank - saved.rank)
        || Number(row.time) - Number(saved.time) || row.placement.localeCompare(saved.placement);
      const remaining = current.filter((row) => compare(row) > 0);
      const collected: ThreadSibling[] = [];
      let after = saved;
      for (let turn = 0; turn < 20; turn++) {
        const read = await page(`insert-${sort}-${turn}`, parent, sort, 20, after, turn === 0);
        const shown = read.slice(0, 20);
        collected.push(...shown);
        if (read.length <= 20) break;
        after = key(shown.at(-1)!);
      }
      expectKeys(collected, remaining);
      expect(new Set(collected.map((row) => row.reply)).size).toBe(collected.length);
      expect(collected.map((row) => row.reply)).toContain(older.reply);
      expect(collected.map((row) => row.reply)).not.toContain(newer.reply);
      // Full API cursors also bind the graph source position: the insertion
      // forces an explicit stale restart, at which point the new earlier row
      // is reachable. This store-level seek proves the saved key has no gap.
      expect((await page(`restart-${sort}`, parent, sort, 20, undefined, false))
        .map((row) => row.reply)).toContain(newer.reply);
    }

    const branchRoot = native(70000);
    await insert(Array.from({ length: 33 }, (_, depth) => ({
      reply: native(70001 + depth), parent: native(70000 + depth),
      placement: native(170001 + depth), time: baseTime + depth * 1000,
      score: 0, active: true,
    })));
    await access.query(`UPDATE access.realm_thread_reference SET thread=$3
      WHERE data_epoch=$1 AND realm=$2 AND reply=ANY($4::text[])`, [epoch, realm, branchRoot,
      Array.from({ length: 33 }, (_, depth) => native(70001 + depth))]);
    expect(await store.threadRoot(epoch, realm, native(70033))).toBe(branchRoot);
    let branchFocus = branchRoot;
    const reached = [branchFocus];
    for (let depth = 1; depth <= REALM_THREAD_COST.depth; depth++) {
      const read = await page(`branch-${depth}`, branchFocus, 'new', 1, undefined, depth === 1);
      expect(read).toHaveLength(1);
      expect(read[0]!.hasChildren).toBe(true);
      branchFocus = read[0]!.reply;
      reached.push(branchFocus);
    }
    expect(branchFocus).toBe(native(70032));
    const continued = await page('branch-33-new-focus', branchFocus, 'new', 1);
    expect(continued).toMatchObject([{ reply: native(70033), hasChildren: false }]);
    reached.push(continued[0]!.reply);
    expect(new Set(reached).size).toBe(34);
  } finally {
    mkdirSync('.temp/realm-thread-continuation', { recursive: true });
    writeFileSync(`.temp/realm-thread-continuation/plans-${runId}.json`, JSON.stringify(evidence, null, 2));
    await Promise.all([access.end(), content.end()]);
    await databases.close();
  }
}, 180_000);
