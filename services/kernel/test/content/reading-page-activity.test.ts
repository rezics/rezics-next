import { expect, test } from 'bun:test';
import { Compile } from 'typebox/compile';
import { CommandUnavailableError } from '../../src/access/unavailable.ts';
import type { ConversationActivityBatch, ConversationActivityCurrent } from '../../src/content/conversation-activity.ts';
import { ReadingPageActivitySchema, selectReadingPageActivity } from '../../src/content/reading-page-activity.ts';

const place = {
  threadId: '00000000-0000-4000-8000-000000000001',
  boardId: '00000000-0000-4000-8000-000000000002',
  threadSecurityRevision: '3', boardSecurityRevision: '4', realmId: null,
};
function current(kind: 'exact' | 'lower-bound', value: number): ConversationActivityCurrent {
  return {
    threadId: place.threadId, status: 'current', cohort: 'public', replyCount: { kind, value },
    lastContributionAt: value === 0 ? null : '2026-11-04T00:00:00.000Z',
    witness: {
      ...place, boardGeneration: '1', generation: '2', sourceHead: { epoch: 1, position: 9n, eventSeq: 0 },
      source: {
        partition: { partitionNo: 0, node: 'local', writeState: 'active', movedTo: null, epoch: 1, position: 9n },
        epoch: 1, position: 9n,
      },
    },
  };
}

test('one selected conversation is confirmed after hydration; exact, bounded and zero meanings are closed', async () => {
  const schema = Compile(ReadingPageActivitySchema);
  for (const [kind, count] of [['exact', 0], ['exact', 7], ['lower-bound', 10_000]] as const) {
    const item = current(kind, count);
    const calls: string[] = [];
    const producer: ConversationActivityBatch = {
      select: async (ids, deadline) => {
        expect(ids).toEqual([place.threadId]); expect(deadline).toBe(123);
        calls.push('select'); return [item];
      },
      confirm: async (selected, deadline) => {
        expect(selected).toEqual([item]); expect(deadline).toBe(123);
        calls.push('confirm'); return selected;
      },
    };
    const activity = await selectReadingPageActivity(producer, place, 123);
    calls.push('foreign hydration');
    const result = await activity.confirm();
    expect(calls).toEqual(['select', 'foreign hydration', 'confirm']);
    expect(result.value).toEqual({ state: 'current', cohort: 'public', count: { kind, value: count }, lastActivityAt: item.lastContributionAt });
    expect(result.anchors).toEqual([item.witness.source]);
    expect(schema.Check(result.value)).toBe(true);
    expect(schema.Check({ ...result.value, witness: item.witness })).toBe(false);
    expect(schema.Check({ ...result.value, cohort: 'viewer' })).toBe(false);
  }
});

test('private cohorts stay withheld, optional outages stay unavailable and changes retry the original page', async () => {
  const item = current('exact', 7);
  for (const reason of ['unsupported-cohort', 'coverage', 'missing'] as const) {
    const hidden = { threadId: place.threadId, status: 'withheld' as const, reason };
    const activity = await selectReadingPageActivity({ select: async () => [hidden], confirm: async (s) => s }, place, 123);
    expect(await activity.confirm()).toEqual({ value: { state: 'withheld' }, anchors: [] });
  }
  for (const phase of ['select', 'confirm']) {
    const producer: ConversationActivityBatch = {
      select: async () => [item], confirm: async (s) => s,
      [phase]: async () => { throw new CommandUnavailableError('overloaded', 0); },
    };
    const activity = await selectReadingPageActivity(producer, place, 123);
    expect(await activity.confirm()).toEqual({ value: { state: 'unavailable', retryable: true }, anchors: [] });
  }
  const changed = await selectReadingPageActivity({
    select: async () => [item],
    confirm: async () => [{ threadId: place.threadId, status: 'withheld', reason: 'stale' }],
  }, place, 123);
  await expect(changed.confirm()).rejects.toThrow('The reading page changed during hydration');
  await expect(selectReadingPageActivity({ select: async () => [item], confirm: async (s) => s }, { ...place, boardSecurityRevision: '5' }, 123)).rejects.toThrow('The reading page changed during hydration');
});
