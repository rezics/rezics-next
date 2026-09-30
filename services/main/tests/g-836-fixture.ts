import { randomUUID } from 'node:crypto';
import { type Json } from '../src/modules/editorial-review/contract.ts';
import { checkedOutcome, itemCommandKey, mergeDigest, MergeConflict, MergePending,
  type IdentityHeader, type MergeHandler, type MergeTask, type RecordedItem,
  type ItemOutcome, type OwnerCheckpoint, type OwnerPage, type TaskCompletion }
  from '../src/modules/identity-merge/contract.ts';
import { checkedPage, type MergeJournal, type MergeJournalScope } from '../src/modules/identity-merge/journal.ts';
import type { MergeTaskRuntime } from '../src/modules/identity-merge/engine.ts';

export const resource = (n: number) => `https://rezics.com/id/00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
export function header(n: number): IdentityHeader {
  return { resource: resource(n), revision: resource(n + 100), grain: 'work',
    titles: [{ language: 'ja', value: 'ソードアート・オンライン 1' },
      { language: 'zh-Hant', value: '刀劍神域 1' }, { language: 'en', value: 'Sword Art Online 1' }],
    creators: [{ resource: resource(10), names: [{ language: 'ja', value: '川原礫' }] }],
    dates: [{ precision: 'day', value: '2009-04-10' }],
    identifiers: [{ scheme: 'isbn-13', value: '9784048677608' }] };
}
export function task(operation: 'merge' | 'unmerge' = 'merge', original?: MergeTask): MergeTask {
  const plan = { operation, source: { resource: resource(1), revision: resource(101) },
    survivor: { resource: resource(2), revision: resource(102) },
    evidence: [{ resource: resource(10), revision: resource(110), locator: null }],
    ...(operation === 'unmerge' ? { original: original!.key } : {}) } as MergeTask['plan'];
  return { key: `editorial:${randomUUID()}:1`, application: randomUUID(), plan,
    candidateDigest: mergeDigest(plan), dataEpoch: 'epoch-a', handlers: [{ owner: 'fixture', version: 'v1' }] };
}
interface MemoryTask { task: MergeTask; pages: Map<string, OwnerCheckpoint>;
  items: Map<string, RecordedItem>; completion: TaskCompletion | null }
const clone = <T>(value: T): T => structuredClone(value);
export class MemoryJournal implements MergeJournal {
  readonly tasks = new Map<string, MemoryTask>();
  private readonly locks = new Set<string>();
  failNextRecord = false;
  failNextFinish = false;
  failNextPrepare = false;
  async locked<T>(key: string, work: (scope: MergeJournalScope) => Promise<T>): Promise<T> {
    if (this.locks.has(key)) throw new MergePending('already running');
    this.locks.add(key);
    const get = () => this.tasks.get(key)!;
    const scope: MergeJournalScope = {
      task: async () => clone(this.tasks.get(key)?.task ?? null),
      prepare: async wanted => {
        if (this.failNextPrepare) { this.failNextPrepare = false; throw new Error('before durable task'); }
        const old = this.tasks.get(key);
        if (old && mergeDigest(old.task) !== mergeDigest(wanted)) throw new MergeConflict('wrong task');
        this.tasks.set(key, old ?? { task: clone(wanted), pages: new Map(), items: new Map(), completion: null });
      },
      checkpoint: async owner => clone(get().pages.get(owner) ?? { after: null, exhausted: false, page: 0 }),
      pending: async (owner, limit) => clone([...get().items.values()].filter(item => item.owner === owner && !item.result).slice(0, limit)),
      capture: async (owner, before, page) => {
        checkedPage(page, before.after);
        if ((await scope.pending(owner, 1)).length) throw new MergeConflict('pending items');
        for (const item of page.items) get().items.set(`${owner}:${item.key}`, { ...clone(item), owner, result: null });
        get().pages.set(owner, { after: page.next, exhausted: page.next === null, page: before.page + 1 });
      },
      record: async (owner, item, result) => {
        if (this.failNextRecord) { this.failNextRecord = false; throw new Error('lost journal acknowledgement'); }
        const row = get().items.get(`${owner}:${item}`)!;
        if (row.result && mergeDigest(row.result) !== mergeDigest(result)) throw new MergeConflict('wrong outcome');
        row.result = clone(result);
      },
      original: async original => {
        const row = this.tasks.get(original);
        if (!row?.completion || row.task.plan.operation !== 'merge') throw new Error('incomplete original');
        return clone(row.task);
      },
      originalItem: async (original, owner, key) => clone(this.tasks.get(original)!.items.get(`${owner}:${key}`)!),
      compensationPage: async (original, owner, after, limit) => {
        const rows = [...this.tasks.get(original)!.items.values()].filter(item => item.owner === owner
          && item.result && ['moved', 'history'].includes(item.result.outcome)
          && (after === null || item.key > after)).slice(0, limit + 1);
        const kept = rows.slice(0, limit);
        return { items: kept.map(item => ({ key: item.key, expectedHead: item.result!.afterHead,
          before: { original, owner, key: item.key,
            snapshotDigest: mergeDigest({ key: item.key, expectedHead: item.expectedHead, before: item.before }),
            outcomeDigest: mergeDigest(item.result) } })), next: rows.length > limit ? kept.at(-1)!.key : null };
      },
      completion: async () => clone(this.tasks.get(key)?.completion ?? null),
      finish: async completion => {
        if (this.failNextFinish) { this.failNextFinish = false; throw new Error('lost completion acknowledgement'); }
        if ([...get().items.values()].some(item => !item.result)) throw new MergeConflict('pending item');
        get().completion = clone(completion);
      },
    };
    try { return await work(scope); } finally { this.locks.delete(key); }
  }
}
export function fixture(size = 5) {
  const journal = new MemoryJournal(), wanted = task();
  const values = new Map(Array.from({ length: size }, (_, n) => [`item-${String(n).padStart(5, '0')}`, { head: `before-${n}`, value: `value-${n}` }]));
  const receipts = new Map<string, ItemOutcome>(), finalReceipts = new Map<string, TaskCompletion>();
  let writes = 0, reserves = 0, finalizations = 0, compensateCalls = 0;
  let lose = false;
  const apply: MergeHandler['apply'] = async (_task, item, commandKey) => {
    if (receipts.has(commandKey)) return clone(receipts.get(commandKey)!);
    const current = values.get(item.key)!;
    if (current.head !== item.expectedHead) throw new MergeConflict('stale owner head');
    values.set(item.key, { ...current, head: `after:${commandKey}` }); writes++;
    const result: ItemOutcome = { outcome: 'moved', receipt: `urn:fixture:${commandKey}`, commandKey,
      afterHead: `after:${commandKey}`, after: clone(values.get(item.key)!) };
    receipts.set(commandKey, result);
    if (lose) { lose = false; throw new Error('lost owner acknowledgement'); }
    return clone(result);
  };
  const handler: MergeHandler = { owner: 'fixture', version: 'v1', references: ['table:fixture.item.target'],
    cost: { page: 4, callsPerItem: 1, bytesPerItem: 4096 },
    preview: async () => ({ owner: 'fixture', count: Math.min(size, 4), complete: size <= 4 }),
    plan: async (_task, after, limit): Promise<OwnerPage> => {
      const keys = [...values.keys()].filter(key => after === null || key > after).slice(0, limit + 1);
      return { items: keys.slice(0, limit).map(key => ({ key, expectedHead: values.get(key)!.head, before: clone(values.get(key)!) })),
        next: keys.length > limit ? keys[limit - 1]! : null };
    },
    apply,
    compensate: async (_task, original, commandKey) => {
      if (receipts.has(commandKey)) return clone(receipts.get(commandKey)!);
      compensateCalls++;
      const current = values.get(original.key)!;
      const moved = current.head === original.result.afterHead;
      if (moved) values.set(original.key, { ...(original.before as { head: string; value: string }), head: `compensated:${commandKey}` });
      const result: ItemOutcome = { outcome: moved ? 'moved' : 'ambiguous', commandKey,
        receipt: `urn:fixture:${commandKey}`, afterHead: values.get(original.key)!.head,
        after: clone(values.get(original.key)!) as Json };
      checkedOutcome(result, commandKey); receipts.set(commandKey, result); return clone(result);
    },
  };
  const runtime: MergeTaskRuntime<unknown> = { dependencies: {}, dataEpoch: 'epoch-a',
    checkDeadline() {},
    async begin() { reserves++; },
    async finish(wantedTask, key) {
      if (finalReceipts.has(key)) return clone(finalReceipts.get(key)!);
      finalizations++;
      const result = { commandKey: key, receipt: `urn:fixture:${key}`, result: { source: wantedTask.plan.source.resource,
        survivor: wantedTask.plan.survivor.resource } };
      finalReceipts.set(key, result); return clone(result);
    } };
  return { journal, wanted, handler, runtime, values, receipts,
    writes: () => writes, reserves: () => reserves, finalizations: () => finalizations,
    compensateCalls: () => compensateCalls, lose: () => { lose = true; },
    key: (item: string, t = wanted) => itemCommandKey(t.key, handler.owner, item) };
}
