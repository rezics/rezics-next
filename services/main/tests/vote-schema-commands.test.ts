import { expect, test } from 'bun:test';
import { countingSlotIri } from '../src/modules/vote/access.ts';
import { checkPreparePoll, planAllocation, proportionalShares } from '../src/modules/vote/commands.ts';
import { VoteRejected, VoteStale } from '../src/modules/vote/graph.ts';
import type { PollView, SeatView } from '../src/modules/vote/read.ts';

const pollId = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const organization = 'https://rezics.com/id/00000000-0000-4000-8000-000000000002';
const member = 'https://rezics.com/id/00000000-0000-4000-8000-000000000003';
const rootId = 'https://rezics.com/id/00000000-0000-4000-8000-000000000004';
const rootSlot = countingSlotIri(pollId, 'organization', organization);
const memberSlot = countingSlotIri(pollId, 'person', 'principal-one');

const poll = {
  poll: pollId, state: 'draft', charter: { allocation: true,
    admittedSeatClasses: ['organization', 'person'] },
} as PollView;
const root = { seat: rootId, kind: 'root', holder: organization, seatClass: 'organization',
  units: 100, countingSlot: rootSlot, counted: true } as SeatView;

test('GOV11/GOV15: a second representation preserves one counting seat; distinct organizations differ', () => {
  expect(countingSlotIri(pollId, 'organization', organization)).toBe(rootSlot);
  expect(countingSlotIri(pollId, 'organization', member)).not.toBe(rootSlot);
  expect(countingSlotIri(pollId, 'person', 'principal-one')).toBe(memberSlot);
});

test('GOV13/GOV14: partial allocation deduplicates a leaf and retains exact residual ownership', () => {
  const intent = { poll: pollId, rootEntitlement: rootId, holder: organization,
    leaves: [
      { holder: member, seatClass: 'person' as const, units: 40 },
      { holder: member, seatClass: 'person' as const, units: 40 },
    ] };
  expect(planAllocation(poll, root, intent, [memberSlot, memberSlot])).toEqual([
    { holder: member, seatClass: 'person', units: 40, slot: memberSlot, residual: false },
    { holder: organization, seatClass: 'organization', units: 60, slot: rootSlot, residual: true },
  ]);
  expect(() => planAllocation(poll, root, { ...intent, leaves: [
    { holder: member, seatClass: 'person', units: 101 },
  ] }, [memberSlot])).toThrow(VoteRejected);
  expect(() => planAllocation(poll, { ...root, counted: false }, intent,
    [memberSlot, memberSlot])).toThrow(VoteStale);
});

test('GOV14: duplicate counting identity with conflicting units cannot issue two leaves', () => {
  const intent = { poll: pollId, rootEntitlement: rootId, holder: organization,
    leaves: [
      { holder: member, seatClass: 'person' as const, units: 40 },
      { holder: member, seatClass: 'person' as const, units: 60 },
    ] };
  expect(() => planAllocation(poll, root, intent, [memberSlot, memberSlot])).toThrow(VoteRejected);
  expect(() => planAllocation(poll, root, { ...intent, leaves: [intent.leaves[0]!] },
    [rootSlot])).toThrow(VoteRejected);
});

test('GOV17: proportional conversion conserves external units with deterministic ties', () => {
  expect(proportionalShares(100, [{ key: 'a', units: 1 }, { key: 'b', units: 2 }])).toEqual([
    { option: 'a', units: 33 }, { option: 'b', units: 67 },
  ]);
  expect(proportionalShares(1, [{ key: 'b', units: 1 }, { key: 'a', units: 1 }])).toEqual([
    { option: 'a', units: 1 },
  ]);
});

test('GOV15: a duplicate electorate counting identity is rejected before a snapshot', () => {
  const intent = { poll: pollId, body: organization,
    charter: { ruleRevision: rootId, unitScale: 1, countingUnit: 'weight' as const,
      admittedSeatClasses: ['person' as const], allocation: false, quorumThreshold: 1,
      abstention: 'counts' as const, passNumerator: 1, passDenominator: 2,
      invalidation: 'none' as const },
    question: { text: 'Choose', language: 'en' },
    options: [
      { key: 'yes', role: 'approve' as const, label: 'Yes' },
      { key: 'no', role: 'reject' as const, label: 'No' },
    ], entitlements: [
      { holder: organization, seatClass: 'person' as const, units: 1 },
      { holder: member, seatClass: 'person' as const, units: 1 },
    ] };
  expect(() => checkPreparePoll(intent, [memberSlot, memberSlot])).toThrow(VoteRejected);
});
