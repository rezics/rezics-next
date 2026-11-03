import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import {
  readViewerFacts,
  readViewerFactsPage,
  prepareViewerFacts,
  viewerFactsCurrent,
} from '../../src/library/viewer-facts.ts';
import { createCollectionReads } from '../../src/library/collection-reads.ts';
import { withReadTransaction } from '../../src/semantic/read.ts';
import { routeOf } from '../../src/route/route.ts';
import type { AccountActor } from '../../src/request/access.ts';
import { communityFixtureRuntime } from '../community/community-driver.ts';
import {
  createSourceStatisticLifecycleFixture,
  type SourceStatisticLifecycleFixture,
} from '../rating/source-statistic-lifecycle-fixture.ts';

let fixture: SourceStatisticLifecycleFixture;
let owner: AccountActor;
const deadline = () => Date.now() + 120_000;
const deps = () => ({ pool: fixture.database.pool, access: fixture.access });
const votePath = (id: string) => `/v1/subjects/${id}/ratings/${STANDARD_QUESTION_ID}/vote`;
const inputs = (ids: string[]) => ids.map((subjectId, index) => ({ rowKey: String(index), subjectId }));
const page = (ids: string[], actor = owner, question = STANDARD_QUESTION_ID) =>
  readViewerFactsPage(deps(), actor, inputs(ids), question, deadline());

beforeAll(async () => {
  fixture = await createSourceStatisticLifecycleFixture({ nativeFigures: true });
  fixture.database.pool.options.max = 1;
  const context = await fixture.identityCommand('rating:vote');
  owner = { ...context.actor, scopes: [...context.actor.scopes, 'library_entry:read', 'library_entry:list'] };
}, 180_000);
afterAll(async () => {
  await fixture?.close();
}, 180_000);

async function vote(id: string, units: number | null) {
  const response = await fixture.request(
    units === null ? 'DELETE' : 'PUT',
    votePath(id),
    units === null ? {} : { body: { units } },
  );
  expect(response.status, await response.clone().text()).toBe(units === null ? 204 : 200);
}
async function entry(id: string, state: string) {
  await fixture.database.admin.query(
    `INSERT INTO library.entry
    (route,account_id,subject_id,state,revision,created_at,updated_at,transaction_id,incarnation_id)
    VALUES($1,$2,$3,$4,1,now(),now(),$5,$6)`,
    [routeOf(owner.accountId), owner.accountId, id, state, randomUUID(), randomUUID()],
  );
}
async function staged(id: string) {
  const prepared = await prepareViewerFacts(deps(), owner, inputs([id]), STANDARD_QUESTION_ID, deadline());
  const result = await withReadTransaction(
    fixture.database.pool,
    (client) => readViewerFacts(client, owner, prepared),
    deadline(),
  );
  expect(result.state).toBe('current');
  return prepared;
}

test('native merge selection reaches survivor and redirected duplicate rows with exact Entry precedence', async () => {
  const [original, survivor, absent] = await Promise.all([
    fixture.createSubject(),
    fixture.createSubject(),
    fixture.createSubject(),
  ]);
  await entry(original, 'paused');
  await entry(survivor, 'planned');
  await vote(original, 7);
  await fixture.merge(original, survivor);
  expect(await page([original, survivor])).toMatchObject({ state: 'unavailable', retryable: true });
  await fixture.nativeFigures!.drain();
  const expectedVote = {
    state: 'present',
    units: 7,
    revision: 1,
  };
  expect(await page([original, survivor, survivor, absent])).toMatchObject({
    state: 'current',
    rows: [
      {
        rowKey: '0',
        subjectId: original,
        entry: { entryState: 'paused' },
        vote: expectedVote,
      },
      {
        rowKey: '1',
        subjectId: survivor,
        entry: { entryState: 'planned' },
        vote: expectedVote,
      },
      { rowKey: '2', subjectId: survivor, vote: expectedVote },
      { rowKey: '3', entry: { state: 'absent' }, vote: { state: 'absent' } },
    ],
  });
  expect(await page([original], { ...owner, accountId: fixture.nativeFigures!.globalVoters[1]!.id })).toMatchObject({
    state: 'current',
    rows: [{ entry: { state: 'absent' }, vote: { state: 'absent' } }],
  });
  const reads = createCollectionReads({
    ...deps(),
    tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(9)]]) },
  });
  expect(
    await reads.withViewerFacts(owner, { members: [{ id: 'admitted', subjectId: survivor }] }, deadline()),
  ).toMatchObject({ viewerFacts: { rows: [{ rowKey: 'admitted', vote: expectedVote }] } });
  await fixture.database.admin.query('DELETE FROM library.entry WHERE account_id=$1 AND subject_id=$2', [
    owner.accountId,
    original,
  ]);
  expect(await page([original])).toMatchObject({ state: 'current', rows: [{ entry: { entryState: 'planned' } }] });
  await fixture.database.admin.query(
    "UPDATE library.entry SET state='paused',revision=2 WHERE account_id=$1 AND subject_id=$2",
    [owner.accountId, survivor],
  );
  expect(await page([survivor])).toMatchObject({
    state: 'current',
    rows: [{ entry: { state: 'present', entryState: 'paused', revision: 2 } }],
  });
  await vote(survivor, 0);
  expect(await page([original, survivor])).toMatchObject({
    state: 'current',
    rows: [{ vote: { state: 'present', units: 0 } }, { vote: { state: 'present', units: 0 } }],
  });
  await vote(survivor, null);
  expect(await page([survivor, absent])).toMatchObject({
    state: 'current',
    rows: [{ vote: { state: 'absent' } }, { vote: { state: 'absent' } }],
  });
  expect(await page(Array(100).fill(survivor))).toMatchObject({ state: 'current', rows: expect.any(Array) });
  await expect(page(Array(101).fill(survivor))).rejects.toThrow('at most 100 rows');
  await expect(
    readViewerFactsPage(
      deps(),
      owner,
      [{ rowKey: 'x'.repeat(16_384), subjectId: survivor }],
      STANDARD_QUESTION_ID,
      deadline(),
    ),
  ).rejects.toThrow('16384');
}, 180_000);

test('selected row and account changes withhold stale assembly, while unchanged same-input visits complete', async () => {
  const id = await fixture.createSubject();
  await vote(id, 8);
  const unchanged = await staged(id);
  expect(await viewerFactsCurrent(deps(), owner, unchanged, deadline())).toBe(true);
  const changed = await staged(id);
  await vote(id, 9);
  expect(await viewerFactsCurrent(deps(), owner, changed, deadline())).toBe(false);
  expect(await page([id])).toMatchObject({ state: 'current', rows: [{ vote: { units: 9 } }] });
  const scoped = await staged(id);
  expect(await viewerFactsCurrent(deps(), { ...owner, scopes: ['library_entry:read'] }, scoped, deadline())).toBe(
    false,
  );
  expect(await page([id], { ...owner, scopes: ['library_entry:read'] })).toMatchObject({
    state: 'current',
    rows: [{ vote: { state: 'unavailable', reason: 'scope' } }],
  });
  expect(await page([id], owner, id)).toMatchObject({
    state: 'current',
    rows: [{ vote: { state: 'unavailable', reason: 'question' } }],
  });
  const question = await staged(id);
  await fixture.database.admin.query('UPDATE rating.question SET revision=revision+1 WHERE id=$1', [
    STANDARD_QUESTION_ID,
  ]);
  try {
    expect(await viewerFactsCurrent(deps(), owner, question, deadline())).toBe(false);
  } finally {
    await fixture.database.admin.query('UPDATE rating.question SET revision=1 WHERE id=$1', [STANDARD_QUESTION_ID]);
  }
  const account = await staged(id);
  await fixture.database.admin.query('UPDATE access.account SET minimum_authn_epoch=2 WHERE account_id=$1', [
    owner.accountId,
  ]);
  try {
    expect(await viewerFactsCurrent(deps(), owner, account, deadline())).toBe(false);
  } finally {
    await fixture.database.admin.query('UPDATE access.account SET minimum_authn_epoch=1 WHERE account_id=$1', [
      owner.accountId,
    ]);
  }
}, 180_000);

test('late Subject disclosure loss refuses currentness and never exposes a concealed terminal', async () => {
  const id = await fixture.createSubject();
  await vote(id, 4);
  const prepared = await staged(id);
  const { system, kernel } = communityFixtureRuntime();
  const response = await kernel.handle(
    new Request(`http://kernel.test/v1/subjects/${id}:hide`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${system.actors.moderator.bearer}`,
        'content-type': 'application/json',
        'idempotency-key': JSON.stringify(randomUUID()),
      },
      body: JSON.stringify({ reason: 'Current Subject disclosure' }),
    }),
  );
  expect(response.status, await response.clone().text()).toBe(200);
  expect(await viewerFactsCurrent(deps(), owner, prepared, deadline())).toBe(false);
  expect(await page([id])).toMatchObject({
    state: 'unavailable',
    reason: 'identity',
    retryable: true,
  });
}, 180_000);
