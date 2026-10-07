import { expect, test } from 'bun:test';
import { mergeDigest } from '../src/modules/identity-merge/contract.ts';
import { checkedPage } from '../src/modules/identity-merge/journal.ts';
import type { MergeDependencies } from '../src/modules/identity-merge/runtime.ts';
import {
  ratingMergeHandler,
  RATING_MERGE_NATIVE_INVENTORY_SQL,
  RATING_MERGE_SELECTION_INVENTORY_SQL,
} from '../src/modules/rating/merge-handler.ts';
import { resource, task } from './g-836-fixture.ts';

const principal = (n: number) => `00000000-0000-0000-0000-${n.toString(16).padStart(12, '0')}`;
const grain = (person: number, context = 10) => `${principal(person)}|${resource(context)}`;
const compare = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

function fixture(native: string[], selected: string[]) {
  const calls: { sql: string; after: string; bound: number; rows: number }[] = [];
  let releases = 0;
  const dependencies = {
    accessPool: {
      async query(sql: string, values: [string, string, string, number]) {
        expect([RATING_MERGE_NATIVE_INVENTORY_SQL, RATING_MERGE_SELECTION_INVENTORY_SQL]).toContain(sql);
        expect(values[0]).toBe(resource(1));
        const after = `${values[1]}|${values[2]}`;
        const rows = (sql === RATING_MERGE_NATIVE_INVENTORY_SQL ? native : selected)
          .filter(key => compare(key, after) > 0).sort(compare).slice(0, values[3]);
        calls.push({ sql, after, bound: values[3], rows: rows.length });
        return { rows: rows.map(key => { const [principal, context] = key.split('|'); return { principal, context }; }) };
      },
      async connect() { return { release() { releases++; } }; },
    },
    graph: { async query() { return { boolean: false }; } },
  } as unknown as MergeDependencies;
  return { dependencies, handler: ratingMergeHandler(dependencies), calls, releases: () => releases };
}

async function traverse(native: string[], selected: string[], limit: number) {
  const f = fixture(native, selected), wanted = task(), keys: string[] = [];
  let after: string | null = null, pages = 0;
  do {
    const page = checkedPage(await f.handler.plan(wanted, after, limit, f.dependencies), after, limit);
    keys.push(...page.items.map(item => item.key));
    for (const item of page.items) {
      expect(item.before).toEqual({ policy: 'exact-rating-grain', context: item.key.split('|')[1] });
      expect(item.expectedHead).toBe(mergeDigest(item.before));
    }
    after = page.next;
    expect(++pages).toBeLessThanOrEqual(new Set([...native, ...selected]).size + 1);
  } while (after !== null);
  expect(keys).toEqual([...new Set([...native, ...selected])].sort(compare));
  expect(f.calls.every(call => call.bound === limit + 1 && call.rows <= limit + 1)).toBe(true);
  expect(f.calls).toHaveLength(pages * 2);
  expect(f.releases()).toBe(pages);
  expect(f.handler.version).toBe('effective-person-vote-v3');
  return f;
}

test('rating inventory preserves bytewise person/context cursors across sparse interleaved and overlapping sources', async () => {
  await traverse([grain(0), grain(2, 12), grain(2, 10), grain(20)],
    [grain(1), grain(2, 11), grain(2, 12), grain(15), grain(30)], 2);
  for (const [native, selected] of [[[], []], [[grain(0)], []], [[], [grain(0)]],
    [[grain(0)], [grain(0)]], [[grain(1), grain(2)], [grain(1), grain(2)]]]) {
    await traverse(native!, selected!, 2);
  }
});

test('raw history saturation returns a short resumable page and never claims EOF from deduplicated size', async () => {
  const native = [...Array<string>(10_000).fill(grain(1)), grain(2), grain(4)];
  const selected = [grain(0), grain(1), grain(3), grain(5)];
  const f = fixture(native, selected), wanted = task();
  const first = await f.handler.plan(wanted, null, 3, f.dependencies);
  expect(first.items.map(item => item.key)).toEqual([grain(0), grain(1)]);
  expect(first.next).toBe(grain(1));
  expect(await f.handler.plan(wanted, null, 3, f.dependencies)).toEqual(first);
  const second = await f.handler.plan(wanted, first.next, 3, f.dependencies);
  expect(second.items.map(item => item.key)).toEqual([grain(2), grain(3), grain(4)]);
  expect(second.next).toBe(grain(4));
  expect(f.calls.slice(4, 6).every(call => call.after === grain(1))).toBe(true);
  expect(await f.handler.preview(wanted.plan, f.dependencies)).toEqual({ owner: 'rating', count: 2, complete: false });
  await traverse(native, selected, 3);

  const onlyHistory = fixture(Array<string>(33).fill(grain(1)), []);
  const page = await onlyHistory.handler.plan(wanted, null, 32, onlyHistory.dependencies);
  expect(page.items).toHaveLength(1);
  expect(page.next).toBe(grain(1));
  expect(await onlyHistory.handler.plan(wanted, page.next, 32, onlyHistory.dependencies)).toEqual({ items: [], next: null });
  expect(await onlyHistory.handler.preview(wanted.plan, onlyHistory.dependencies)).toEqual({ owner: 'rating', count: 1, complete: false });
});

test('preview completion follows raw exhaustion and capped distinct overflow', async () => {
  for (const size of [0, 1, 32, 33, 64]) {
    const keys = Array.from({ length: size }, (_, i) => grain(i));
    const f = fixture(keys.filter((_, i) => i % 2 === 0), keys.filter((_, i) => i % 2 === 1));
    expect(await f.handler.preview(task().plan, f.dependencies)).toEqual({
      owner: 'rating', count: Math.min(size, 32), complete: size <= 32,
    });
    expect(f.calls.every(call => call.bound === 33)).toBe(true);
  }
  const shortHistory = fixture(Array<string>(32).fill(grain(1)), [grain(1)]);
  expect(await shortHistory.handler.preview(task().plan, shortHistory.dependencies)).toEqual({ owner: 'rating', count: 1, complete: true });
});

test('bounded common-frontier pagination exhausts every grain under varied duplicate and sparse distributions', async () => {
  let state = 19;
  const random = () => { state = (state * 1664525 + 1013904223) >>> 0; return state; };
  for (let run = 0; run < 100; run++) {
    const native: string[] = [], selected: string[] = [];
    for (let i = 0; i < 12; i++) {
      const key = grain(Math.floor(i / 3), 10 + i % 3);
      native.push(...Array<string>([0, 1, 2, 20][random() % 4]!).fill(key));
      selected.push(...Array<string>([0, 1, 5][random() % 3]!).fill(key));
    }
    await traverse(native, selected, 1 + run % 5);
  }
});

test('standing inventory retains exact source/survivor snapshots and current-Main selection origin reads', async () => {
  const wanted = task(), key = grain(1), context = resource(10);
  const sourceHead = { main_version: resource(101), slot: 'source-slot', revision: resource(201) };
  const survivorHead = { main_version: resource(900), slot: 'origin-slot', revision: resource(202) };
  const selection = { origin_main_version: resource(900), origin_slot: 'origin-slot' };
  let released = false;
  const dependencies = {
    accessPool: {
      async query(sql: string) { return { rows: sql === RATING_MERGE_NATIVE_INVENTORY_SQL ? [{ principal: principal(1), context }] : [] }; },
      async connect() { return {
        async query(sql: string, values: string[]) {
          if (sql.includes('rating_merge_selection')) {
            expect(values).toEqual([context, values[1], principal(1), values[1] === resource(1) ? resource(101) : resource(102)]);
            return { rows: values[1] === resource(1) ? [] : [{ row: selection }] };
          }
          if (sql.includes('FOR UPDATE')) return { rows: values[1] === resource(1) ? [{ row: sourceHead }] : [] };
          expect(values).toEqual([context, resource(900), 'origin-slot']);
          return { rows: [{ row: survivorHead }] };
        },
        release() { released = true; },
      }; },
    },
    graph: { async query(sql: string) {
      if (sql.includes('ASK')) return { boolean: true };
      return { results: { bindings: [{ main: { type: 'uri', value: sql.includes(`<${resource(1)}>` ) ? resource(101) : resource(102) } }] } };
    } },
  } as unknown as MergeDependencies;
  const page = await ratingMergeHandler(dependencies).plan(wanted, null, 2, dependencies);
  const before = { source: { head: sourceHead, selection: null }, survivor: { head: survivorHead, selection } };
  expect(page).toEqual({ items: [{ key, before, expectedHead: mergeDigest(before) }], next: null });
  expect(released).toBe(true);
});
