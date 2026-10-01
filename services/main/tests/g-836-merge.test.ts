import { expect, test } from 'bun:test';
import { checkedPlan, InvalidMerge, MERGE_COST, mergeDigest, MergeConflict, MergePending, MergeUnavailable }
  from '../src/modules/identity-merge/contract.ts';
import { runMergeFixture } from './g-836-task-driver.ts';
import { assertMergeCoverage } from '../src/modules/identity-merge/handlers.ts';
import { checkedPage } from '../src/modules/identity-merge/journal.ts';
import { previewMerge, resolveMergedIdentity } from '../src/modules/identity-merge/preflight.ts';
import { fixture, header, resource, task } from './g-836-fixture.ts';

test('G836: preview preserves multilingual grain, creators, dates, identifiers and capped owner counts', async () => {
  const f = fixture(7);
  const owner = { read: async (id: string) => ({ header: header(id === resource(1) ? 1 : 2), accountControlled: false }),
    redirectOf: async () => null };
  const preview = await previewMerge(f.wanted.plan, owner, [f.handler], {});
  expect(preview.source.titles.map(value => value.language)).toEqual(['ja', 'zh-Hant', 'en']);
  expect(preview.source.creators).toEqual(header(1).creators);
  expect(preview.survivor.identifiers).toEqual(header(2).identifiers);
  expect(preview.owners).toEqual([{ owner: 'fixture', count: 4, complete: false }]);
  expect(f.writes()).toBe(0);
});

test('G836: self, split, unsupported fields, missing evidence, controlled Agents, hidden and stale identities fail before writes', async () => {
  const f = fixture();
  for (const invalid of [{ ...f.wanted.plan, survivor: f.wanted.plan.source },
    { ...f.wanted.plan, operation: 'split' }, { ...f.wanted.plan, transferGrants: true },
    { ...f.wanted.plan, evidence: [] }]) expect(() => checkedPlan(invalid)).toThrow(InvalidMerge);
  const owner = { read: async (id: string) => ({ header: header(id === resource(1) ? 1 : 2), accountControlled: true }),
    redirectOf: async () => null };
  await expect(previewMerge(f.wanted.plan, owner, [f.handler], {})).rejects.toBeInstanceOf(InvalidMerge);
  await expect(previewMerge(f.wanted.plan, { ...owner, read: async () => null }, [f.handler], {})).rejects.toBeInstanceOf(MergeUnavailable);
  await expect(previewMerge(f.wanted.plan, { ...owner, read: async id => ({ header: { ...header(id === resource(1) ? 1 : 2),
    revision: resource(200) }, accountControlled: false }) }, [f.handler], {})).rejects.toMatchObject({ code: 'stale_base' });
  expect(f.writes()).toBe(0);
});

test('G836: redirects share address hop limit, reject malformed/cyclic chains and return a typed merged identity', async () => {
  expect(await resolveMergedIdentity(resource(1), id => id === resource(1) ? resource(2) : null))
    .toEqual({ state: 'merged', source: resource(1), survivor: resource(2), hops: 1 });
  expect(await resolveMergedIdentity(resource(1), () => null)).toEqual({ state: 'identity', resource: resource(1) });
  await expect(resolveMergedIdentity(resource(1), () => resource(1))).rejects.toThrow('cycle');
  await expect(resolveMergedIdentity(resource(1), () => 'javascript:bad')).rejects.toBeInstanceOf(MergeUnavailable);
  const redirect = (id: string) => Number(id.slice(-12)) <= MERGE_COST.redirectHops ? resource(Number(id.slice(-12)) + 1) : null;
  expect(await resolveMergedIdentity(resource(1), redirect)).toMatchObject({ hops: MERGE_COST.redirectHops });
  await expect(resolveMergedIdentity(resource(1), id => resource(Number(id.slice(-12)) + 1))).rejects.toThrow('hop limit');
});

test('G836: cycle/grain and chained unmerge preflight cannot silently choose another survivor', async () => {
  const f = fixture();
  const owner = { read: async (id: string) => ({ header: header(id === resource(1) ? 1 : 2), accountControlled: false }),
    redirectOf: async (id: string) => id === resource(1) ? resource(2) : resource(1) };
  await expect(previewMerge(f.wanted.plan, owner, [f.handler], {})).rejects.toThrow('cycle');
  await expect(previewMerge(f.wanted.plan, { ...owner, redirectOf: async () => null,
    read: async id => ({ header: { ...header(id === resource(1) ? 1 : 2), grain: id === resource(1) ? 'work' : 'release' }, accountControlled: false }) },
  [f.handler], {})).rejects.toThrow('grains');
  const undo = task('unmerge', f.wanted);
  await expect(previewMerge(undo.plan, { ...owner, redirectOf: async id => id === resource(1) ? resource(2)
    : id === resource(2) ? resource(3) : null }, [f.handler], {})).rejects.toThrow('exact direct merge');
});

test('G836: inventory pages are a request budget and tasks resume past 32 items exactly once', async () => {
  const f = fixture(65);
  expect(await runMergeFixture(f.wanted, f.journal, [f.handler], f.runtime)).toMatchObject({ state: 'pending', processed: 32 });
  expect(f.writes()).toBe(32); expect(f.finalizations()).toBe(0);
  expect(await runMergeFixture(f.wanted, f.journal, [f.handler], f.runtime)).toMatchObject({ state: 'pending', processed: 32 });
  const done = await runMergeFixture(f.wanted, f.journal, [f.handler], f.runtime);
  expect(done.state).toBe('complete'); expect(f.writes()).toBe(65); expect(f.finalizations()).toBe(1);
  const replay = await runMergeFixture(f.wanted, f.journal, [f.handler], f.runtime);
  expect(replay.completion).toEqual(done.completion); expect(replay.processed).toBe(0);
  expect(f.writes()).toBe(65); expect(f.reserves()).toBe(3);
});

test('G836: lost owner receipt response and crash before Access item outcome replay the original command before its CAS', async () => {
  for (const fault of ['owner-response', 'access-outcome'] as const) {
    const f = fixture();
    if (fault === 'owner-response') f.lose(); else f.journal.failNextRecord = true;
    await expect(runMergeFixture(f.wanted, f.journal, [f.handler], f.runtime)).rejects.toThrow('acknowledgement');
    expect(f.writes()).toBe(1);
    const originalReceipt = f.receipts.get(f.key('item-00000'))!;
    const resumed = await runMergeFixture(f.wanted, f.journal, [f.handler], f.runtime);
    expect(resumed.state).toBe('complete'); expect(f.writes()).toBe(5);
    expect(f.journal.tasks.get(f.wanted.key)!.items.get('fixture:item-00000')!.result).toEqual(originalReceipt);
  }
});

test('G836: task persistence precedes reservation and finalization retries resolve the same identity receipt', async () => {
  const f = fixture(); f.journal.failNextPrepare = true;
  await expect(runMergeFixture(f.wanted, f.journal, [f.handler], f.runtime)).rejects.toThrow('durable task');
  expect(f.reserves()).toBe(0); expect(f.writes()).toBe(0);
  f.journal.failNextFinish = true;
  await expect(runMergeFixture(f.wanted, f.journal, [f.handler], f.runtime)).rejects.toThrow('completion acknowledgement');
  expect(f.writes()).toBe(5); expect(f.finalizations()).toBe(1);
  expect((await runMergeFixture(f.wanted, f.journal, [f.handler], f.runtime)).state).toBe('complete');
  expect(f.finalizations()).toBe(1);
});

test('G836: compensation uses only original moved/history items, retains later edits as ambiguous and excludes new survivor items', async () => {
  const f = fixture();
  await runMergeFixture(f.wanted, f.journal, [f.handler], f.runtime);
  f.values.set('item-00001', { head: 'later-review', value: 'post-merge review' });
  f.values.set('unrelated-survivor-item', { head: 'new', value: 'never moved' });
  const retained = f.journal.tasks.get(f.wanted.key)!;
  retained.items.get('fixture:item-00002')!.result!.outcome = 'retained';
  retained.items.get('fixture:item-00003')!.result!.outcome = 'history';
  const undo = task('unmerge', f.wanted);
  expect((await runMergeFixture(undo, f.journal, [f.handler], f.runtime)).state).toBe('complete');
  expect(f.compensateCalls()).toBe(4);
  expect(f.values.get('item-00001')).toEqual({ head: 'later-review', value: 'post-merge review' });
  expect(f.journal.tasks.get(undo.key)!.items.get('fixture:item-00001')!.result!.outcome).toBe('ambiguous');
  expect(f.values.get('unrelated-survivor-item')).toEqual({ head: 'new', value: 'never moved' });
  expect(f.journal.tasks.get(undo.key)!.items.has('fixture:item-00002')).toBe(false);
  await runMergeFixture(undo, f.journal, [f.handler], f.runtime); expect(f.compensateCalls()).toBe(4);
});

test('G836: owner substitution, wrong receipt key, changed handler versions and restore epochs fail closed', async () => {
  const f = fixture();
  await expect(runMergeFixture(f.wanted, f.journal, [{ ...f.handler, version: 'v2' }], f.runtime)).rejects.toBeInstanceOf(MergeUnavailable);
  await expect(runMergeFixture(f.wanted, f.journal, [f.handler], { ...f.runtime, dataEpoch: 'restored' })).rejects.toBeInstanceOf(MergeUnavailable);
  await expect(runMergeFixture(f.wanted, f.journal, [{ ...f.handler, apply: async (...args) => ({ ...await f.handler.apply(...args), commandKey: 'wrong' }) }],
    f.runtime)).rejects.toThrow('exact receipt');
  expect(f.journal.tasks.get(f.wanted.key)!.items.get('fixture:item-00000')!.result).toBeNull();
  const other = { ...f.wanted, plan: { ...f.wanted.plan, evidence: [{ resource: resource(20), revision: resource(21), locator: null }] } };
  other.candidateDigest = mergeDigest(other.plan);
  await expect(runMergeFixture(other, f.journal, [f.handler], f.runtime)).rejects.toBeInstanceOf(MergeConflict);
});

test('G836: concurrent task runs cannot deliver the same inventory while the owner is blocked', async () => {
  const f = fixture(1);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  const slow = { ...f.handler, apply: async (...args: Parameters<typeof f.handler.apply>) => {
    enter(); await released; return f.handler.apply(...args);
  } };
  const first = runMergeFixture(f.wanted, f.journal, [slow], f.runtime);
  try {
    await entered;
    await expect(runMergeFixture(f.wanted, f.journal, [slow], f.runtime)).rejects.toBeInstanceOf(MergePending);
    expect(f.writes()).toBe(0);
  } finally { release(); }
  expect((await first).state).toBe('complete'); expect(f.writes()).toBe(1);
});

test('G836: a denied identity reservation never dispatches an owner and does not forget the retained task', async () => {
  const f = fixture();
  await expect(runMergeFixture(f.wanted, f.journal, [f.handler], { ...f.runtime,
    begin: async () => { throw new MergeUnavailable('current reviewed authority denied'); } }))
    .rejects.toThrow('authority denied');
  expect(f.writes()).toBe(0); expect(f.finalizations()).toBe(0);
  expect(f.journal.tasks.get(f.wanted.key)!.task).toEqual(f.wanted);
  expect((await runMergeFixture(f.wanted, f.journal, [f.handler], f.runtime)).state).toBe('complete');
});

test('G836: compensation references keep maximum-size original snapshots and receipts within the item budget', async () => {
  const f = fixture(1);
  const handler = { ...f.handler, plan: async (...args: Parameters<typeof f.handler.plan>) => {
    const page = await f.handler.plan(...args);
    page.items[0]!.before = { head: 'before-0', value: 'original', preserved: 'a'.repeat(40_000) };
    return page;
  }, apply: async (...args: Parameters<typeof f.handler.apply>) => {
    const result = await f.handler.apply(...args);
    result.after = { head: result.afterHead, retained: 'b'.repeat(40_000) };
    return result;
  } };
  await runMergeFixture(f.wanted, f.journal, [handler], f.runtime);
  const undo = task('unmerge', f.wanted);
  expect((await runMergeFixture(undo, f.journal, [handler], f.runtime)).state).toBe('complete');
  const captured = f.journal.tasks.get(undo.key)!.items.get('fixture:item-00000')!;
  expect(Buffer.byteLength(JSON.stringify(captured.before))).toBeLessThan(512);
  expect(f.values.get('item-00000')!.value).toBe('original');
});

test('G836: class guard rejects a new unhandled table/predicate and invalid wildcard-like exclusions', () => {
  const f = fixture();
  const references = ['table:fixture.item.target', 'predicate:https://rezics.com/vocab/creatorRights'];
  expect(() => assertMergeCoverage(references, [f.handler], {})).toThrow('creatorRights');
  expect(() => assertMergeCoverage(references, [f.handler], { [references[1]!]: 'Creator rights never move' })).not.toThrow();
  expect(() => assertMergeCoverage([...references, 'table:new_owner.thing.target'], [f.handler],
    { [references[1]!]: 'Creator rights never move' })).toThrow('new_owner');
  expect(() => assertMergeCoverage(references, [f.handler], { [references[1]!]: ' ' })).toThrow('Invalid merge exclusion');
  expect(() => assertMergeCoverage(references, [f.handler], { 'table:fixture.item.target': 'ignore' })).toThrow('Invalid merge exclusion');
});

test('G836: malformed pages, duplicate keys, nonadvancing and speculative cursors cannot lose inventory', () => {
  const item = { key: 'a', expectedHead: 'head', before: {} };
  for (const page of [{ items: [], next: 'a' }, { items: [item, item], next: null },
    { items: [item], next: 'b' }]) expect(() => checkedPage(page, null)).toThrow(InvalidMerge);
  expect(() => checkedPage({ items: [item], next: null }, 'b')).toThrow('advance');
  expect(() => checkedPage({ items: [{ ...item, before: { content: 'x'.repeat(MERGE_COST.itemBytes) } }], next: null }, null)).toThrow();
});
