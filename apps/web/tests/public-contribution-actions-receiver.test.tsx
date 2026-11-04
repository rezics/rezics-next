import { expect, test } from 'bun:test';
import {
  contributionActionsInput,
  ContributionActionsReceiver,
  unavailableAuthorContributionActionsWire,
} from '../src/accounts/public-profile/contribution-actions/receiver';

const id = '00000000-0000-4000-8000-000000000001';
const reference = { type: 'content.thread', id, placeId: id, sourceRevisionId: id };
const selection = { proof: 'native-proof', references: [reference] };
const input = () => contributionActionsInput(id, 'discussion', 'original-cursor', selection)!;

test('only a bounded native selection supplies the exact immutable input', () => {
  expect(contributionActionsInput(id, 'discussion', null, undefined)).toBeUndefined();
  expect(contributionActionsInput(id, 'discussion', null, { ...selection, references: [] })).toBeUndefined();
  expect(contributionActionsInput(id, 'discussion', null, { ...selection, references: Array(21).fill(reference) })).toBeUndefined();
  expect(contributionActionsInput(id, 'discussion', null, { ...selection, references: [reference, reference] })).toBeUndefined();
  expect(contributionActionsInput(id, 'posts', null, selection)).toBeUndefined();
  const admitted = input();
  expect(admitted.references).toEqual(selection.references);
  expect(admitted.cursor).toBe('original-cursor');
  expect(Object.isFrozen(admitted.references[0])).toBe(true);
  expect(Object.isFrozen(admitted)).toBe(true);
});

test('production remains unavailable without the installed publisher method', async () => {
  const receiver = new ContributionActionsReceiver(input(), unavailableAuthorContributionActionsWire, () => true);
  await receiver.refresh();
  expect(receiver.snapshot()).toEqual({ state: 'unavailable' });
});

test('refresh coalesces; failed retries preserve the selected page and original frontier', async () => {
  const calls: unknown[] = [];
  const selected = input();
  const receiver = new ContributionActionsReceiver(selected, {
    async read(value) {
      calls.push(value);
      if (calls.length === 1) throw new Error('temporarily unavailable');
      return { own: 'withheld' };
    },
  }, () => true);
  const first = receiver.refresh();
  expect(receiver.refresh()).toBe(first);
  await first;
  expect(receiver.snapshot()).toEqual({ state: 'failed' });
  await receiver.refresh();
  expect(receiver.snapshot()).toEqual({ state: 'ready', value: { own: 'withheld' } });
  expect(calls).toEqual([selected, selected]);
  expect(calls[0]).toBe(calls[1]);
});

test('a retired credential/page episode aborts and cannot revive controls with a late result', async () => {
  let finish!: (value: string) => void;
  let signal!: AbortSignal;
  const receiver = new ContributionActionsReceiver(input(), {
    read(_value, abort) { signal = abort; return new Promise<string>((resolve) => { finish = resolve; }); },
  }, () => true);
  const pending = receiver.refresh();
  await Promise.resolve();
  receiver.retire();
  expect(signal.aborted).toBe(true);
  finish('old own slot');
  await pending;
  await receiver.refresh();
  expect(receiver.isCurrent()).toBe(false);
  expect(receiver.snapshot()).toEqual({ state: 'retired' });
});
