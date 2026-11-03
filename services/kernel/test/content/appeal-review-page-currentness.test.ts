import { afterAll, beforeAll, expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import identities from '../../src/access/public-identity-page.sql';
import targets from '../../src/content/appeal-review-page-targets.sql';
import { createGrowthAppealBoundariesFixture } from './support/growth-appeal-boundaries-fixture.ts';

let fixture: Awaited<ReturnType<typeof createGrowthAppealBoundariesFixture>>;
beforeAll(async () => {
  fixture = await createGrowthAppealBoundariesFixture();
}, 300_000);
afterAll(async () => {
  await fixture?.close();
});

async function selected(label: string, resolved = false) {
  const { people } = fixture;
  const boardId = await fixture.createBoard(label);
  const thread = await fixture.createThread(boardId, label);
  const reply = await fixture.command<{ post: { id: string } }>(
    'POST',
    `/v1/threads/${thread.threadId}/posts`,
    { body: fromPlainText('Private removed body sentinel'), licence: 'MIT', subjectIds: [] },
    { bearer: people.author.bearer, expectedStatus: 201 },
  );
  const { record } = await fixture.submitAppeal(boardId, { ...thread, postId: reply.body.post.id }, true, 'post');
  await fixture.grant(boardId, people.reviewer.accountId, ['moderation:read_reports']);
  if (resolved) {
    const resolution = await fixture.command(
      'POST',
      `/v1/moderation-appeals/${record.appealId}:resolve`,
      { outcome: 'uphold', statement: 'Retained exact outcome' },
      { bearer: people.reviewer.bearer, expectedStatus: 200 },
    );
    await fixture.completeRegisteredCommand(people.reviewer.accountId, resolution.key, 'content.resolve-appeal');
  }
  await fixture.grant(thread.threadId, people.decider.accountId, ['moderation:takedown']);
  return { boardId, thread, record, path: `/v1/boards/${boardId}/appeals?limit=2` };
}

for (const resolved of [false, true]) {
  test(`final native target disclosure qualifies the ${resolved ? 'exact retained selection' : 'pending queue row'}`, async () => {
    const item = await selected(`Final target ${resolved}`, resolved);
    const path = item.path + (resolved ? `&inspect=${item.record.appealId}` : '');
    const read = () => fixture.call('GET', path, { bearer: fixture.people.reviewer.bearer });
    const before = await read();
    expect(before.response.status).toBe(200);
    const row = (body: Record<string, any> | null) => (resolved ? body?.selectedAppeal : body?.appeals[0]);
    expect(row(before.body).targetContext).toMatchObject({ state: 'available' });
    // The initial target read is complete; retire its destination while the final identity read prepares.
    const barrier = fixture.observer.hold({ statement: identities.sql, occurrence: 2 }, 'before');
    const pending = read();
    try {
      await barrier.entered;
      await fixture.command(
        'POST',
        `/v1/threads/${item.thread.threadId}:takeDown`,
        { reason: 'Current target disclosure reduction' },
        { bearer: fixture.people.decider.bearer, expectedStatus: 200 },
      );
    } finally {
      barrier.release();
    }
    const after = await pending;
    expect(after.response.status).toBe(200);
    expect(after.body?.next).toBe(before.body?.next);
    expect(row(after.body)).toMatchObject({ id: item.record.appealId, targetContext: { state: 'concealed' } });
    if (resolved)
      expect(row(after.body).resolution).toMatchObject({ outcome: 'upheld', statement: 'Retained exact outcome' });
    else expect(row(after.body).canResolve).toBe(true);
    expect(after.text).not.toContain('Private removed body sentinel');
    expect(after.text).not.toContain(fixture.people.decider.accountId);
  }, 300_000);
}

test('a current identity deletion and failed final target read never restore earlier labels or destinations', async () => {
  const item = await selected('Final optional reductions', true);
  const path = `${item.path}&inspect=${item.record.appealId}`;
  const before = await fixture.call('GET', path, { bearer: fixture.people.reviewer.bearer });
  expect(before.body?.selectedAppeal.appellantIdentity.state).toBe('available');
  const barrier = fixture.observer.hold({ statement: identities.sql, occurrence: 2 }, 'before');
  fixture.observer.armFault({
    match: { statement: targets.sql, occurrence: 2 },
    boundary: 'before',
    error: new Error('Native final target unavailable'),
  });
  const pending = fixture.call('GET', path, { bearer: fixture.people.reviewer.bearer });
  try {
    await barrier.entered;
    await fixture.deleteAppellant();
  } finally {
    barrier.release();
  }
  const after = await pending;
  expect(after.response.status).toBe(200);
  expect(after.body?.selectedAppeal).toMatchObject({
    id: item.record.appealId,
    appellantIdentity: { state: 'deleted' },
    targetContext: { state: 'unavailable' },
    resolution: { outcome: 'upheld', statement: 'Retained exact outcome' },
  });
  expect(after.body?.appeals).toEqual([]);
  expect(after.body?.next).toBeNull();
}, 300_000);
