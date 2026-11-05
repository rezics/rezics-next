import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createDeletionFixture } from './support/deletion-fixture.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';

const f = await createDeletionFixture();
beforeAll(f.setup);
afterAll(f.close);

test('revision explanation follows actual decisions and ranks, without returning historical text or actor basis', async () => {
  const subject = await f.person();
  const proposed = await f.call('POST', `/v1/subjects/${subject}/candidates`, 'owner', {
    statement: f.cited('schema:url', 'https://example.test/revision-evidence'),
  });
  f.status(proposed, 201);
  const candidate = proposed.body.candidate as string;
  const revision = proposed.body.revision as number;
  const path = `/v1/subjects/${subject}/revisions/${revision}`;
  const pending = await f.call('GET', path, 'owner');
  f.status(pending, 200);
  expect(pending.body).toEqual({
    subject,
    revision: { revision, kind: 'propose', release: expect.any(String) },
    change: {
      kind: 'candidate',
      candidate,
      property: 'schema:url',
      context: GLOBAL_CONTEXT,
      reading: { decision: null, selected: false, rank: null },
    },
  });
  await f.accept({ subject, candidate });
  await f.adopt({ subject, candidate }, null);
  await f.caughtUp(subject);
  const selected = await f.call('GET', path, 'owner');
  f.status(selected, 200);
  expect(selected.body.change.reading).toMatchObject({
    selected: true,
    rank: 'normal',
    decision: { verdict: 'accept' },
  });
  const serialized = JSON.stringify(selected.body);
  for (const withheld of [
    'revision-evidence',
    'actor',
    'token',
    'recorded_transaction_id',
    'write_basis',
    f.accounts.owner,
  ])
    expect(serialized).not.toContain(withheld);
  const decisions = await f.revisions(subject);
  for (const entry of decisions.filter((entry) => ['accept', 'adopt'].includes(entry.kind))) {
    const detail = await f.call('GET', `/v1/subjects/${subject}/revisions/${entry.revision}`, 'owner');
    f.status(detail, 200);
    expect(detail.body.change.kind).toBe(entry.kind === 'accept' ? 'decision' : 'adoption');
  }
});

test('revision details conceal unknown, hidden candidate and nonvisible Subject records', async () => {
  const record = await f.proposal(await f.person());
  const revisions = await f.revisions(record.subject);
  const revision = revisions.find((entry) => entry.kind === 'propose')!.revision;
  const path = `/v1/subjects/${record.subject}/revisions/${revision}`;
  f.status(await f.call('GET', path, 'owner'), 200);
  f.status(await f.call('GET', `/v1/subjects/${record.subject}/revisions/2147483647`, 'owner'), 404);
  f.status(
    await f.call('POST', `${f.path(record)}:takedown`, 'platform', {
      notice: { complaint: 'Covered contribution', received_at: f.clock().toISOString(), scope: '/' },
    }),
    200,
  );
  f.status(await f.call('GET', path, 'owner'), 404);
  f.status(
    await f.call('POST', `/v1/subjects/${record.subject}:takedown`, 'platform', {
      notice: { complaint: 'Covered subject', received_at: f.clock().toISOString(), scope: '/' },
    }),
    200,
  );
  f.status(await f.call('GET', `/v1/subjects/${record.subject}/revisions/1`, 'owner'), 404);
});
