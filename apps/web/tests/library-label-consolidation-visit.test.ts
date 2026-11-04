import { expect, test } from 'bun:test';
import { ConsolidationVisit, type ConsolidationEnvelope } from '../src/library/label-consolidation/visit';
import { ConsolidationReview } from '../src/library/label-consolidation/review';
import type { consolidationClient, ReviewPage } from '../src/library/label-consolidation/client';

const selected = { subjectId: 'subject', assignmentId: 'original-source', revision: 3 };
const evidence: ReviewPage = {
  selection: 'digest',
  sourceLabel: { id: 'source', revision: 1, name: 'Source' },
  targetLabel: { id: 'target', revision: 2, name: 'Target' },
  items: [
    { selected, source: { id: selected.assignmentId, revision: 3, effective: true }, target: null, outcome: 'movable' },
  ],
  next: null,
};
const confirmed = {
  confirmationId: 'original-plan',
  status: 'active',
  expiresAt: '2030-01-01T00:00:00Z',
  itemCount: 1,
};
function fixture() {
  let retire = () => {};
  let current = true;
  let allowed = true;
  let fail = '';
  let rejection = '';
  let afterDispatch = () => {};
  const calls: unknown[][] = [];
  const refreshes: string[][] = [];
  const envelope: ConsolidationEnvelope = {
    capture: () => (allowed ? { headers: { 'x-csrf-token': 'fresh-token' }, isCurrent: () => current } : null),
    subscribeRetirement: (fn) => {
      retire = fn;
      return () => {};
    },
  };
  const result = {
    confirmationId: confirmed.confirmationId,
    sourceLabelId: 'source',
    targetLabelId: 'target',
    status: 'completed',
    expiresAt: confirmed.expiresAt,
    items: [
      {
        item: 0,
        status: 'moved',
        selected,
        targetAssignment: { id: 'native-target', revision: 1 },
        sourceUnassignRevision: 4,
      },
    ],
  };
  const send = async (operation: string, ...args: unknown[]) => {
    calls.push([operation, ...structuredClone(args)]);
    afterDispatch();
    if (fail === operation) throw new Error('acknowledgement lost');
    if (rejection) return { data: null, error: { code: rejection } };
    return {
      data: operation === 'review' ? structuredClone(evidence) : operation === 'confirm' ? confirmed : result,
      error: null,
    };
  };
  const transport = Object.fromEntries(
    ['review', 'confirm', 'apply', 'retry', 'cancel', 'result'].map((name) => [
      name,
      (...args: unknown[]) => send(name, ...args),
    ]),
  ) as unknown as ReturnType<typeof consolidationClient>;
  let keys = 0;
  const visit = new ConsolidationVisit(
    new ConsolidationReview('source', 'target', [selected]),
    envelope,
    (headers) => {
      expect(headers['x-csrf-token']).toBe('fresh-token');
      return transport;
    },
    (...ids) => refreshes.push(ids),
    () => `key-${++keys}`,
  );
  return {
    visit,
    calls,
    refreshes,
    result,
    retire: () => retire(),
    deny: () => {
      allowed = false;
    },
    stale: () => {
      current = false;
    },
    fail: (operation: string) => {
      fail = operation;
    },
    reject: (reason: string) => {
      rejection = reason;
    },
    after: (fn: () => void) => {
      afterDispatch = fn;
    },
  };
}

test('full evidence and original caller keys survive unknown confirmation and apply acknowledgements', async () => {
  const f = fixture();
  expect(await f.visit.confirm()).toBe('unavailable');
  expect(await f.visit.nextPage()).toBe('accepted');
  f.fail('confirm');
  expect(await f.visit.confirm()).toBe('unknown');
  expect(await f.visit.apply()).toBe('unavailable');
  f.fail('');
  expect(await f.visit.recover()).toBe('accepted');
  expect(f.calls[1]).toEqual(f.calls[2]);
  expect(f.calls[1]).toEqual([
    'confirm',
    {
      selection: evidence.selection,
      sourceLabel: evidence.sourceLabel,
      targetLabel: evidence.targetLabel,
      items: evidence.items,
    },
    'key-1',
  ]);
  f.fail('apply');
  expect(await f.visit.apply()).toBe('unknown');
  expect(await f.visit.cancel()).toBe('unavailable');
  f.fail('');
  expect(await f.visit.recover()).toBe('accepted');
  expect(f.calls[3]).toEqual(f.calls[4]);
  expect(f.calls[4]).toEqual(['apply', 'original-plan', 'key-2']);
  expect(f.refreshes).toEqual([['source', 'target']]);
  const result = f.visit.result!;
  result.items.length = 0;
  expect(f.visit.result!.items).toHaveLength(1);
});

test('retirement clears private evidence and refuses late acknowledgements', async () => {
  const f = fixture();
  await f.visit.nextPage();
  f.after(f.retire);
  expect(await f.visit.confirm()).toBe('retired');
  expect(f.visit.review.evidence).toEqual([]);
  expect(f.visit.confirmation).toBeNull();
  expect(f.visit.result).toBeNull();
  expect(f.visit.acknowledgementUnknown).toBe(false);
  expect(await f.visit.recover()).toBe('retired');
});

test('each dispatch recaptures exposure and discards responses from a stale reader', async () => {
  const denied = fixture();
  denied.deny();
  expect(await denied.visit.nextPage()).toBe('unavailable');
  expect(denied.calls).toEqual([]);
  const f = fixture();
  await f.visit.nextPage();
  await f.visit.confirm();
  f.after(f.stale);
  expect(await f.visit.apply()).toBe('retired');
  expect(f.visit.result).toBeNull();
  expect(f.refreshes).toEqual([]);
});

test('native processing retry, cancel and result retain native observations', async () => {
  const f = fixture();
  await f.visit.nextPage();
  await f.visit.confirm();
  expect(await f.visit.retry(0)).toBe('unavailable');
  f.result.items[0]!.status = 'processing';
  await f.visit.readResult();
  expect(await f.visit.retry(0)).toBe('accepted');
  expect(f.calls.at(-1)).toEqual(['retry', 'original-plan', 0, 'key-2']);
  expect(await f.visit.cancel()).toBe('accepted');
  expect(f.calls.at(-1)).toEqual(['cancel', 'original-plan', 'key-3']);
});

for (const reason of ['expired', 'changed'])
  test(`${reason} retains original confirmed operands`, async () => {
    const f = fixture();
    await f.visit.nextPage();
    await f.visit.confirm();
    f.reject(reason);
    expect(await f.visit.apply()).toBe('rejected');
    expect(f.visit.acknowledgementUnknown).toBe(false);
    expect(await f.visit.confirm()).toBe('unavailable');
    expect(await f.visit.recover()).toBe('rejected');
    expect(f.calls.at(-1)).toEqual(f.calls.at(-2));
    expect(f.refreshes).toEqual([]);
  });
