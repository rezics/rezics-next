import { expect, test } from 'bun:test';
import { accessFixtureApi, ownRequestFixture } from '../manage/settings-fixtures.ts';
import { emptyRequestJournal, journalAfterStatus, readCurrentRequest } from './request-state.ts';

test('G-989: acceptance followed by leaving permits a new request and retains the earlier decision', async () => {
  const accepted = ownRequestFixture('accepted');
  const api = accessFixtureApi({}, accepted);
  expect(await readCurrentRequest(api)).toEqual({ ok: true, data: { entry: accepted.items[0], state: 'available' } });
  expect(await api.mine(null)).toEqual({ ok: true, data: accepted });
});

test('G-989: an accepted request remains current while Main says membership is joined', async () => {
  const accepted = ownRequestFixture('accepted');
  const api = accessFixtureApi({ basis: async () => ({ ok: true, data: {
    policyRevision: '12', termsRevision: 'rules-3', membershipGeneration: '5', state: 'joined',
  } }) }, accepted);
  expect(await readCurrentRequest(api)).toEqual({ ok: true, data: { entry: accepted.items[0], state: 'accepted' } });
});

for (const failure of ['denied', 'unavailable', 'stale'] as const)
  test(`G-989: ${failure} current membership cannot turn historical acceptance into an available action`, async () => {
    const api = accessFixtureApi({ basis: async () => ({ ok: false, failure }) }, ownRequestFixture('accepted'));
    expect(await readCurrentRequest(api)).toEqual({ ok: false, failure });
  });

for (const state of ['pending', 'declined', 'withdrawn'] as const)
  test(`G-989: ${state} remains its owner status without a redundant membership read`, async () => {
    const history = ownRequestFixture(state);
    const api = accessFixtureApi({ basis: async () => { throw new Error('unexpected basis read'); } }, history);
    expect(await readCurrentRequest(api)).toEqual({ ok: true, data: { entry: history.items[0], state } });
  });

test('G-989: historical acceptance resolves its lost-response intent after leaving', () => {
  const current = ownRequestFixture('accepted').items[0]!;
  const command = { actingSubject: current.member, expectedMembershipGeneration: current.membershipGeneration,
    expectedPolicyRevision: current.policyRevision, termsRevision: current.termsRevision, reason: current.reason };
  const journal = { ...emptyRequestJournal(), draftReason: current.reason,
    requestIntent: { command, key: 'lost-original-request' } };
  expect(journalAfterStatus(journal, current, false)).toEqual(emptyRequestJournal());
});

test('G-989: an earlier decision cannot clear a new uncertain rejoining intent or its draft', () => {
  const current = ownRequestFixture('accepted').items[0]!;
  const journal = { ...emptyRequestJournal(), draftReason: 'I would like to return.', requestIntent: {
    key: 'lost-rejoining-request', command: { actingSubject: current.member, expectedMembershipGeneration: '6',
      expectedPolicyRevision: current.policyRevision, termsRevision: current.termsRevision, reason: 'I would like to return.' },
  } };
  expect(journalAfterStatus(journal, current, false)).toEqual(journal);
});
