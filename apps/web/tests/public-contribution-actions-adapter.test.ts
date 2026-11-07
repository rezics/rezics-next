import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import {
  authorContributionActionsWire,
  type AuthorContributionActionsResponse,
} from '../src/accounts/public-profile/contribution-actions/wire';
import { contributionActionsInput } from '../src/accounts/public-profile/contribution-actions/receiver';
import {
  contributionSelectedState,
  contributionWatchSection,
  contributionReactionSection,
} from '../src/accounts/public-profile/contribution-actions/adapter';

const id = '01a17a3b-0884-721b-91ef-d7ffd7bb58e4';
const revision = '01a17a3b-0884-721b-91ef-d7ffd7bb58e5';
const reference = { type: 'content.thread' as const, id, placeId: id, sourceRevisionId: revision };
function response(): AuthorContributionActionsResponse {
  return {
    viewer: { kind: 'account', id },
    selected: [{ reference, state: 'current', reply: { state: 'available' } }],
    reactions: {
      state: 'current',
      retryable: false,
      items: [{ type: reference.type, id, state: 'current', counts: {}, viewerSelection: null }],
      reactionsAsOf: { epoch: 1, position: '1' },
    },
    actions: { state: 'current', retryable: false, references: [] },
    watch: { state: 'current', retryable: false, items: [{ threadId: id, state: 'current', watching: false }] },
    currentness: {
      source: 'current',
      place: 'current',
      authors: 'current',
      reactions: 'current',
      actions: 'current',
      watch: 'current',
    },
  };
}

test('installed selected callable sends only the original anonymous cohort with private, cancellable reads', async () => {
  const calls: Request[] = [];
  const value = response();
  const client = createKernelClient('https://kernel.invalid', {
    fetch: async (input, init) => {
      calls.push(new Request(input, init));
      return Response.json(value);
    },
  });
  const selection = { proof: 'original-proof', references: [reference] };
  const input = contributionActionsInput(id, 'discussion', 'opaque+/=', selection)!;
  const abort = new AbortController();
  expect(await authorContributionActionsWire(client).read(input, abort.signal)).toEqual(value);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe(`https://kernel.invalid/v1/accounts/${id}/contribution-actions`);
  expect(calls[0]!.method).toBe('POST');
  expect(calls[0]!.cache).toBe('no-store');
  expect(await calls[0]!.json()).toEqual({ ...selection, view: 'discussion', cursor: 'opaque+/=' });
  abort.abort();
  expect(calls[0]!.signal.aborted).toBe(true);
});

test('selected source replacement and withholding cannot lend old actions to an original occurrence', () => {
  const native = response();
  expect(contributionSelectedState(native, reference)).toBe('available');
  native.selected[0]!.state = 'withheld';
  expect(contributionSelectedState(native, reference)).toBe('withheld');
  native.selected[0]!.state = 'current';
  native.selected[0]!.reference = { ...reference, sourceRevisionId: id };
  expect(contributionSelectedState(native, reference)).toBe('unavailable');
  native.selected.push(native.selected[0]!);
  expect(contributionSelectedState(native, reference)).toBe('unavailable');
});

test('reaction null, missing own slot, missing counts, unavailable aggregate and not-applicable remain distinct', () => {
  const native = response();
  expect(contributionReactionSection(native, reference)).toMatchObject({ value: { counts: {}, value: null } });
  const slot = native.reactions.items[0]!;
  delete slot.viewerSelection;
  expect(contributionReactionSection(native, reference)).toEqual({ notice: 'unavailable' });
  slot.viewerSelection = 'love';
  expect(contributionReactionSection(native, reference)).toMatchObject({ value: { value: 'love' } });
  delete slot.counts;
  expect(contributionReactionSection(native, reference)).toEqual({ notice: 'unavailable' });
  slot.state = 'not_applicable';
  expect(contributionReactionSection(native, reference)).toEqual({ notice: 'not_applicable' });
  slot.state = 'current';
  slot.counts = {};
  native.currentness.reactions = 'unavailable';
  expect(contributionReactionSection(native, reference)).toEqual({ notice: 'unavailable' });
});

test('watch state requires the containing thread and currentness; missing does not mean unwatched', () => {
  const native = response();
  expect(contributionWatchSection(native, id)).toEqual({ value: false });
  expect(contributionWatchSection(native, revision)).toEqual({ notice: 'missing' });
  delete native.watch.items[0]!.watching;
  expect(contributionWatchSection(native, id)).toEqual({ notice: 'unavailable' });
  native.currentness.watch = 'sign_in_required';
  expect(contributionWatchSection(native, id)).toEqual({ notice: 'sign_in_required' });
});
