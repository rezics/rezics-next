import { expect, test } from 'bun:test';
import { oauthScopes } from '../../account/src/oauth-scopes/vote.ts';
import { resourceScopes } from '../../account/src/oauth-scopes.ts';
import { ownerOutboxEventHandler } from '../src/modules/outbox/event-handlers.ts';
import { VOTE_SCOPES } from '../src/modules/vote/admitted.ts';
import { receiptFamilies } from '../src/modules/vote/receipt-family.ts';
import { RV, hash } from '../src/modules/work/activate.ts';

test('GOV11/GOV22: vote scopes and receipt event classes are owner-discovered', async () => {
  expect(oauthScopes).toEqual(['vote:manage', 'vote:cast', 'vote:invalidate', 'vote:read']);
  for (const scope of oauthScopes) expect(resourceScopes).toContain(scope);
  expect(VOTE_SCOPES).toEqual({ cast: ['vote:cast'], invalidate: ['vote:invalidate'],
    manage: ['vote:manage'], read: ['vote:read'] });
  const kinds = [
    'PollPreparedEvent', 'HolderCharterChangedEvent', 'AllocationActivatedEvent',
    'PollOpenedEvent', 'PollClosedEvent', 'PollFinalizedEvent', 'BallotChangedEvent',
    'BallotInvalidatedEvent', 'ProxyDesignatedEvent', 'ProxyRevokedEvent',
    'MandateApprovalRecordedEvent', 'VotePollCancelledEvent', 'VoteSeatCancelledEvent',
    'VoteBallotCancelledEvent', 'VoteInvalidationCancelledEvent',
  ];
  for (const kind of kinds) expect(ownerOutboxEventHandler(`${RV}${kind}`)).toBeDefined();
  expect(ownerOutboxEventHandler(`${RV}VoteCommandCancelledEvent`)).toBeUndefined();

  const admissionId = '00000000-0000-4000-8000-000000000001';
  const action = 'governance.poll.administer';
  const receipt = `urn:rezics:receipt:${hash(`${admissionId}\0${receiptFamilies[action]}`)}`;
  const suffix = hash(`${receipt}\0rejected`);
  const eventId = `urn:rezics:event:${suffix}`;
  const handler = ownerOutboxEventHandler(`${RV}VotePollCancelledEvent`)!;
  const fields: Record<string, string> = { admissionId, receipt, outcome: `${RV}Cancelled`,
    reason: `${RV}VoteRejected`, digest: 'a'.repeat(64), authorityEpoch: '1',
    scope: 'vote:poll:00000000-0000-4000-8000-000000000001' };
  const envelope = await handler.read({ fuseki: null as never,
    batch: { batchId: `urn:rezics:outbox:${suffix}`, dataEpoch: admissionId,
      routingEpoch: '1', sequence: '7', eventIds: [eventId] }, eventId, ordinal: 0,
    value: name => fields[name] });
  expect(envelope.type).toBe('com.rezics.vote.poll-cancelled.v1');
  expect(envelope.data.receipt.outcome).toBe('cancelled');
});
