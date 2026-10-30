import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createReactionRelayBase, type ReactionRelayBase } from './reaction-relay-convergence-fixture.ts';
import { routeOf } from '../../src/route/route.ts';

let fixture: ReactionRelayBase;
beforeAll(async () => {
  fixture = await createReactionRelayBase();
}, 120_000);
afterAll(async () => {
  await fixture?.system.close();
});

test('a reporter follows the receipt to their submission and outcome after target removal; unrelated remains 404 and inspection stays full', async () => {
  const target = await fixture.createThread(fixture.mainTarget.boardId, 'Target text must never enter reporter status');
  const original = await fixture.call('GET', `/v1/posts/${target.postId}`);
  expect(original.response.status).toBe(200);
  const submission = {
    target: { kind: 'post', id: target.postId },
    revisionId: original.value!.post.revisionId,
    reason: 'spam',
    evidence: 'My submitted evidence remains available to me.',
  };
  const receipt = await fixture.command<{ reportId: string }>('POST', '/v1/reports', submission);
  const path = `/v1/reports/${receipt.reportId}`;
  const pending = await fixture.call('GET', path, { bearer: fixture.author.bearer });
  expect(pending.response.status).toBe(200);
  expect(pending.response.headers.get('cache-control')).toBe('private, no-store');
  expect(pending.value!.report).toMatchObject({
    ...submission,
    id: receipt.reportId,
    reporterId: fixture.author.accountId,
    targetAvailability: 'available',
    outcome: null,
    resolvedAt: null,
  });
  expect(Object.keys(pending.value!.report).sort()).toEqual(
    [
      'id',
      'target',
      'revisionId',
      'reason',
      'evidence',
      'reporterId',
      'createdAt',
      'resolvedAt',
      'outcome',
      'targetAvailability',
    ].sort(),
  );
  expect(pending.text).not.toContain('Target text must never enter reporter status');
  expect((await fixture.call('GET', path, { bearer: fixture.other.bearer })).response.status).toBe(404);
  expect((await fixture.call('GET', path)).response.status).toBe(404);

  const moderator = fixture.system.actors.moderator;
  await fixture.command(
    'POST',
    '/v1/grants',
    {
      resource: { route: routeOf(target.postId)!, id: target.postId },
      subject: { kind: 'account', id: moderator.actor.accountId },
      actions: ['moderation:read_reports', 'moderation:takedown'],
      valid: '(,)',
    },
    { bearer: fixture.governance.bearer },
  );
  const inspected = await fixture.call('GET', path, { bearer: moderator.bearer });
  expect(inspected.response.status).toBe(200);
  expect(inspected.value!.report).toMatchObject({ ...submission, reporterId: fixture.author.accountId });
  expect(inspected.value!.report).toHaveProperty('partition');
  expect(inspected.value!.report).toHaveProperty('transactionId');
  expect(inspected.value!.report).not.toHaveProperty('targetAvailability');

  await fixture.command('POST', `${path}:dismiss`, {}, { bearer: moderator.bearer, expectedStatus: 200 });
  await fixture.command(
    'POST',
    `/v1/posts/${target.postId}:takeDown`,
    { reason: 'Remove the reported target' },
    { bearer: moderator.bearer, expectedStatus: 200 },
  );
  const removed = await fixture.call('GET', path, { bearer: fixture.author.bearer });
  expect(removed.response.status).toBe(200);
  expect(removed.value!.report).toMatchObject({
    ...submission,
    reporterId: fixture.author.accountId,
    targetAvailability: 'unavailable',
    outcome: 'dismissed',
  });
  expect(removed.value!.report.resolvedAt).toBeString();
  expect(removed.text).not.toContain('Target text must never enter reporter status');
  expect(removed.text).not.toContain('Remove the reported target');
  expect((await fixture.call('GET', path, { bearer: fixture.other.bearer })).response.status).toBe(404);
}, 120_000);
