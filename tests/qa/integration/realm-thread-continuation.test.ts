import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Pool } from 'pg';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { activityTime, bestKey } from '../../../services/main/src/modules/feed/ranking.ts';
import { REALM_THREAD_COST } from '../../../services/main/src/modules/realm-reply/thread-contract.ts';
import { WorkReadUnavailable, type WorkReadSession } from '../../../services/main/src/modules/work/read-session.ts';
import {
  RealmReplyThreadStore,
  type ThreadSibling,
  type ThreadSiblingKey,
} from '../../../services/main/src/modules/realm-reply/thread-store.ts';
import { cloneQaOwnerDatabases } from '../support/databases.ts';

const native = (n: number) =>
  `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const placementV7 = (n: number, time: number) => {
  const timestamp = time.toString(16).padStart(12, '0');
  return `https://rezics.com/id/${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7000-8000-${n.toString(16).padStart(12, '0')}`;
};
const sorts = ['best', 'top', 'new'] as const;
type Sort = (typeof sorts)[number];
interface Plan {
  'Node Type': string;
  Alias?: string;
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
function ordered(references: readonly Reference[], sort: Sort, includeInactive = false): ThreadSiblingKey[] {
  return references.filter((row) => includeInactive || row.active).map((row) => {
    const time = activityTime(row.placement, new Date(0)).time.getTime();
    return {
      rank: sort === 'best' ? -bestKey(row.score, time) : sort === 'top' ? -row.score : 0,
      time: String(-time),
      placement: row.placement,
    };
  }).sort((a, b) => a.rank - b.rank || Number(a.time) - Number(b.time)
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
  const databases = await cloneQaOwnerDatabases(runId, ['access', 'content'], 'owner');
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
    after?: ThreadSiblingKey, explain = true, includeInactive = false): Promise<ThreadSibling[]> => {
    statements = [];
    const rows = await store.siblingPage(epoch, realm, parent, sort, limit, after, includeInactive);
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
        if (after) expect(references.find(node => node.Alias === 'r')?.['Index Cond'], name).toContain(' > ');
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
      access.realm_reply_best(score,placement) AS rank FROM access.realm_thread_reference
      WHERE data_epoch=$1 AND realm=$2 AND placement=$3`, [epoch, realm, row.placement])).rows[0]!;
    return { ...row, rank: canonical.rank };
  };
  const references = (parent: string, first: number, count: number): Reference[] =>
    Array.from({ length: count }, (_, index) => {
      const time = baseTime + Math.floor(index / 16) * 1000;
      return {
        reply: native(first + index), placement: placementV7(first + index + 100000, time), parent,
        // Deliberate score/time ties exercise the placement's final seek key.
        score: index % 5 - 2, time, active: true,
      };
    });
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
    for (const [scope, includeInactive] of [false, true].entries()) {
      const legacyParent = native(97000 + scope * 2), mixedParent = native(97001 + scope * 2);
      const legacy = Array.from({ length: 192 }, (_, index): Reference => ({
        reply: native(500000 + scope * 1000 + index),
        placement: native(550000 + scope * 1000 + index), parent: legacyParent,
        // Delivery is newest last, the opposite of the legacy ID tie-break.
        time: baseTime + index * 60000, score: 0, active: !includeInactive,
      }));
      const mixed = Array.from({ length: 192 }, (_, index): Reference => ({
        reply: native(600000 + scope * 1000 + index),
        placement: index % 2 ? native(650000 + scope * 1000 + index)
          : placementV7(650000 + scope * 1000 + index, baseTime + index % 4 * 1000),
        parent: mixedParent, score: Math.floor(index / 2) % 5 - 2,
        // Neither the legacy fallback nor a UUIDv7's declared time follows
        // this delivery clock. Mixed vote/time ties must keep the old order.
        time: baseTime + (192 - index) * 60000, active: !includeInactive,
      }));
      await insert([...legacy, ...mixed]);
      for (const [name, parent, replies] of [
        ['legacy', legacyParent, legacy], ['mixed', mixedParent, mixed],
      ] as const) for (const sort of sorts) {
        const expected = ordered(replies, sort, includeInactive);
        const first = await page(`${name}-${scope}-${sort}-first`, parent, sort, 191,
          undefined, true, includeInactive);
        expectKeys(first, expected);
        for (const row of first.filter(row => row.placement.slice(-36)[14] !== '7')) {
          expect(row.time).toBe('0');
          expect(new Date(-Number(row.time)).toISOString()).toBe('1970-01-01T00:00:00.000Z');
        }
        if (name === 'legacy') expect(first.map(row => row.placement))
          .toEqual(legacy.map(row => row.placement));
        const shown = first.slice(0, 191);
        const next = await page(`${name}-${scope}-${sort}-continued`, parent, sort, 191,
          key(shown.at(-1)!), true, includeInactive);
        expectKeys(next, expected.slice(191));
        expect(new Set([...shown, ...next].map(row => row.reply)).size).toBe(192);
      }
    }
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
      const focusedBranch = ordered(references(inactive, 40000, 1000), sort);
      expect((await page(`focused-inactive-${sort}`, inactive, sort, 20, undefined, true, true)).map(key))
        .toEqual(focusedBranch.slice(0, 21));
      expect((await page(`focused-inactive-${sort}-continued`, inactive, sort, 20,
        focusedBranch[499], true, true)).map(key)).toEqual(focusedBranch.slice(500, 521));

      const all = ordered(large, sort);
      expectKeys(await page(`10000-${sort}-first`, wide, sort, 20), all.slice(0, 21));
      expectKeys(await page(`10000-${sort}-middle`, wide, sort, 191,
        await seekAnchor(all[4999]!, sort)), all.slice(5000, 5192));
      expectKeys(await page(`10000-${sort}-end`, wide, sort, 20,
        await seekAnchor(all[9998]!, sort)), all.slice(9999));
    }

    const orderRevision = async (parent: string): Promise<string | null> =>
      (await access.query<{ revision: string | null }>(`SELECT
        to_jsonb(r)->>'sibling_rank_revision' AS revision FROM access.realm_thread_reference r
        WHERE data_epoch=$1 AND realm=$2 AND reply=$3`, [epoch, realm, parent])).rows[0]?.revision ?? null;
    const sourceCuts = async () => ({
      graph: (await access.query(`SELECT data_epoch,sequence::text,after_event
        FROM access.realm_thread_checkpoint WHERE data_epoch=$1`, [epoch])).rows[0],
      content: (await content.query(`SELECT data_epoch::text,sequence::text
        FROM content.owner_control WHERE singleton`)).rows[0],
    });
    const projectScore = async (placement: string, score: number) => {
      // FeedStore.vote writes this score; the real realm_thread_vote_changed
      // trigger must update the sibling key and its parent fence together.
      await access.query(`UPDATE access.feed_item SET score=$3,
        best_key=sign($3::integer)*log(1+abs($3::double precision))
          +extract(epoch FROM occurred_at)/86400
        WHERE data_epoch=$1 AND id=$2`, [epoch, placement, score]);
    };
    for (const [index, sort] of (['top', 'best'] as const).entries()) {
      const parent = native(93000 + index * 2), unrelated = native(93001 + index * 2);
      const parentReferences = references(native(92999), 93000 + index * 2, 2);
      const voteRows = references(parent, 300000 + index * 1000, 192).map((row, offset) => {
        const time = baseTime - offset * 1000;
        return { ...row, score: 0, time, placement: placementV7(400000 + index * 1000 + offset, time) };
      });
      const otherChild = { ...references(unrelated, 320000 + index, 1)[0]!, score: 0 };
      await insert([...parentReferences, ...voteRows, otherChild]);
      const unread = voteRows[191]!, delivered = voteRows[0]!;
      await access.query(`INSERT INTO access.feed_item
        (data_epoch,id,sequence,kind,occurred_at,time_basis,score,best_key,realm,
          group_bucket,group_key,group_leader,group_members,sort_time,realm_thread_indexed)
        SELECT data_epoch,placement,1,'reply',occurred_at,'relay',score,
          -access.realm_reply_best(score,placement),realm,
          placement,placement,true,ARRAY[placement],occurred_at,true
        FROM access.realm_thread_reference
        WHERE data_epoch=$1 AND realm=$2 AND placement=ANY($3::text[])`,
      [epoch, realm, [unread.placement, delivered.placement, otherChild.placement]]);
      const cuts = await sourceCuts();
      const first = await page(`vote-${sort}-first`, parent, sort, 191, undefined, false);
      expect(first).toHaveLength(192);
      expect(first[191]!.reply).toBe(unread.reply);
      const saved = key(first[190]!);
      const newBefore = await page(`vote-${sort}-new-before`, parent, 'new', 191, undefined, false);
      const originalRevision = await orderRevision(parent), otherRevision = await orderRevision(unrelated);

      await access.query(`UPDATE access.realm_thread_reference
        SET occurred_at=occurred_at+interval '1 hour',score=score,placement=placement
        WHERE data_epoch=$1 AND realm=$2 AND reply=$3`, [epoch, realm, unread.reply]);
      expect(await orderRevision(parent)).toBe(originalRevision);
      expectKeys(await page(`vote-${sort}-relay-only`, parent, sort, 191, undefined, false), first);
      expectKeys(await page(`vote-${sort}-relay-only-new`, parent, 'new', 191, undefined, false), newBefore);
      expect(await sourceCuts()).toEqual(cuts);

      await projectScore(unread.placement, 1);
      expect((await page(`vote-${sort}-promoted`, parent, sort, 191, undefined, false))[0]!.reply)
        .toBe(unread.reply);
      // Reproduce the silent skip using the old key: source cuts did not move,
      // but the unread oldest sibling now sits before the saved cursor.
      expect(await page(`vote-${sort}-old-key-skips`, parent, sort, 191, saved, false)).toEqual([]);
      expect(await sourceCuts()).toEqual(cuts);
      const promotedRevision = await orderRevision(parent);
      expect(promotedRevision).not.toBe(originalRevision);
      expect(promotedRevision).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(await orderRevision(unrelated)).toBe(otherRevision);
      expectKeys(await page(`vote-${sort}-new-after`, parent, 'new', 191, undefined, false), newBefore);
      expectKeys(await page(`vote-${sort}-new-continuation`, parent, 'new', 191,
        key(newBefore[190]!), false), newBefore.slice(191));

      await projectScore(unread.placement, 1);
      expect(await orderRevision(parent)).toBe(promotedRevision);
      await projectScore(delivered.placement, -1);
      const demotedRevision = await orderRevision(parent);
      expect(demotedRevision).not.toBe(promotedRevision);
      // A delivered reply moving after the key duplicates unless the rank
      // revision expires this cursor, independently of Graph/Content changes.
      expect((await page(`vote-${sort}-old-key-duplicates`, parent, sort, 191, saved, false))
        .map(row => row.reply)).toContain(delivered.reply);
      expect(await sourceCuts()).toEqual(cuts);
      await projectScore(otherChild.placement, 1);
      expect(await orderRevision(parent)).toBe(demotedRevision);
      expect(await orderRevision(unrelated)).not.toBe(otherRevision);

      const parents = [parent, unrelated, ...voteRows.slice(0, 190).map(row => row.reply)];
      // The same reply identities remain in old epochs and other Realms.
      // A global reply-only index would filter this history after seeking and
      // turn a 192-parent fence into work proportional to retained scopes.
      await access.query(`INSERT INTO access.realm_thread_reference
        (data_epoch,realm,reply,placement,parent,thread,work,occurred_at,activity_at,score,active)
        SELECT CASE WHEN scope<=4 THEN r.data_epoch||':retained:'||scope ELSE r.data_epoch END,
          CASE WHEN scope<=4 THEN r.realm ELSE ($4::text[])[scope-4] END,
          r.reply,r.placement,r.parent,r.thread,r.work,r.occurred_at,r.activity_at,r.score,false
        FROM access.realm_thread_reference r CROSS JOIN generate_series(1,8) AS scope
        WHERE r.data_epoch=$1 AND r.realm=$2 AND r.reply=ANY($3::text[])`,
      [epoch, realm, parents, Array.from({ length: 4 }, (_, scope) => native(96000 + scope))]);
      expect(await orderRevision(parent)).toBe(demotedRevision);
      statements = [];
      expect(await store.focusBasis(epoch, realm, parent)).toEqual({ thread: native(92999), active: true });
      expect(statements).toHaveLength(1);
      for (const statement of statements) {
        const plan = (await access.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON,TIMING OFF) ${statement.text}`,
          statement.values)).rows[0]['QUERY PLAN'][0].Plan as Plan;
        evidence.push({ name: `vote-${sort}-focus-basis`, statement: statement.text, plan });
        const all = nodes(plan), probes = all.filter(node => node['Relation Name'] === 'realm_thread_reference');
        expect(probes.length).toBeGreaterThan(0);
        expect(all.some(node => ['Seq Scan', 'Hash', 'Hash Join'].includes(node['Node Type']))).toBe(false);
        expect(probes.every(node => nodes(node).some(index => index['Index Name'] === 'realm_reply_sibling_revision'
          && index['Index Cond']?.includes('data_epoch') && index['Index Cond']?.includes('realm')
          && index['Index Cond']?.includes('reply')))).toBe(true);
        expect(probes.reduce((sum, node) => sum + examined(node), 0)).toBeLessThanOrEqual(1);
      }
      statements = [];
      const revisions = await store.siblingOrderRevisions(epoch, realm, parents);
      expect(revisions.size).toBe(192);
      expect(revisions.get(parent)).toBe(demotedRevision!);
      expect(statements.length).toBeGreaterThan(0);
      for (const statement of statements) {
        const plan = (await access.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON,TIMING OFF) ${statement.text}`,
          statement.values)).rows[0]['QUERY PLAN'][0].Plan as Plan;
        evidence.push({ name: `vote-${sort}-parent-revisions`, statement: statement.text, plan });
        const all = nodes(plan), probes = all.filter(node => node['Relation Name'] === 'realm_thread_reference');
        expect(probes.length).toBeGreaterThan(0);
        expect(all.some(node => ['Seq Scan', 'Hash', 'Hash Join'].includes(node['Node Type']))).toBe(false);
        expect(probes.every(node => nodes(node).some(index => index['Index Name'] === 'realm_reply_sibling_revision'
          && index['Index Cond']?.includes('data_epoch') && index['Index Cond']?.includes('realm')
          && index['Index Cond']?.includes('reply')))).toBe(true);
        expect(probes.reduce((sum, node) => sum + examined(node), 0)).toBeLessThanOrEqual(parents.length);
      }
      await access.query(`DELETE FROM access.realm_thread_reference
        WHERE data_epoch=$1 AND realm=$2 AND reply=$3`, [epoch, realm, parent]);
      await insert(parentReferences.filter(row => row.reply === parent));
      // A recreated projection row starts a fresh token instead of reviving
      // an old cursor whose small integer revision happened to match again.
      expect(await orderRevision(parent)).not.toBe(demotedRevision);
      expect(await sourceCuts()).toEqual(cuts);
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
        placement: placementV7(160000 + index * 2, baseTime + 1000000), score: 1000, time: baseTime + 1000000 };
      const older = { ...original[0]!, reply: native(60001 + index * 2),
        placement: placementV7(160001 + index * 2, baseTime - 1000000), score: -1000, time: baseTime - 1000000 };
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
      placement: placementV7(170001 + depth, baseTime + depth * 1000), time: baseTime + depth * 1000,
      score: 0, active: true,
    })));
    await access.query(`UPDATE access.realm_thread_reference SET thread=$3
      WHERE data_epoch=$1 AND realm=$2 AND reply=ANY($4::text[])`, [epoch, realm, branchRoot,
      Array.from({ length: 33 }, (_, depth) => native(70001 + depth))]);
    expect(await store.focusBasis(epoch, realm, native(70033)))
      .toEqual({ thread: branchRoot, active: true });
    await access.query(`UPDATE access.realm_thread_reference SET active=false
      WHERE data_epoch=$1 AND realm=$2 AND reply=$3`, [epoch, realm, native(70033)]);
    expect(await store.focusBasis(epoch, realm, native(70033)))
      .toEqual({ thread: branchRoot, active: false });
    await access.query(`UPDATE access.realm_thread_reference SET active=true
      WHERE data_epoch=$1 AND realm=$2 AND reply=$3`, [epoch, realm, native(70033)]);
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
}, 480_000);
