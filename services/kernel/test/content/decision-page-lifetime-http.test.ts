import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createDelegationCommands } from '../../src/access/delegation-commands.ts';
import source from '../../src/content/decision-page-source.sql';
import { SESSION_HEADER } from '../../src/http/request.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { accountDeletionRuntime, deletePersona } from '../support/account-deletion.ts';
import { createNativePointFixture, type NativePointFixture } from './moderation-native-point-fixture.ts';
import { observeSql } from './support/sql-observer.ts';

let fixture: NativePointFixture;
beforeAll(async () => {
  fixture = await createNativePointFixture();
}, 120_000);
afterAll(async () => {
  await fixture?.close();
});

async function decision(title: string) {
  const target = await fixture.createThread(fixture.mainBoardId, title);
  await fixture.grant(target.postId, ['moderation:takedown']);
  await fixture.command(
    'POST',
    `/v1/posts/${target.postId}:takeDown`,
    { reason: 'Private retained reason' },
    {
      bearer: fixture.moderator.bearer,
      expectedStatus: 200,
    },
  );
  const { rows } = await fixture.system.database.pool.query<{ decision_id: string }>(
    'SELECT decision_id FROM content.moderation_decision WHERE route=$1 AND target_id=$2',
    [target.postRoute, target.postId],
  );
  expect(rows).toHaveLength(1);
  return { target, id: rows[0]!.decision_id, path: `/v1/moderation-decisions/${rows[0]!.decision_id}` };
}

/** Observe the mounted route, with a real competing native operation at selection. */
async function withheld(path: string, bearer: string, change: (request: Request) => Promise<void>, occurrence = 1) {
  const request = new Request(`https://content.test${path}`, { headers: { authorization: `Bearer ${bearer}` } });
  const observer = observeSql(fixture.system.database.pool);
  const barrier = observer.hold({ statement: source.sql, occurrence }, 'after');
  const reading = fixture.system.kernel.handle(request);
  try {
    await barrier.entered;
    await change(request);
  } finally {
    barrier.release();
    await observer.close();
  }
  const response = await reading;
  const text = await response.text();
  expect(response.status).toBe(404);
  expect(JSON.parse(text).code).toBe('not_found');
  expect(response.headers.get(SESSION_HEADER)).toBeNull();
  expect(text).not.toContain('Private retained reason');
}

for (const differentClient of [false, true]) {
  test(`replacing the ${differentClient ? 'client' : 'same-client bearer'} retires an in-flight decision`, async () => {
    const { path } = await decision(`Credential replacement ${differentClient}`);
    const { system, author } = fixture;
    const clientId = differentClient ? `decision_${crypto.randomUUID()}` : system.auth.ordinaryClient.id;
    if (differentClient)
      await system.nativeAuth.internal.registerClient({
        clientId,
        firstParty: true,
        scopes: [...system.auth.ordinaryScopes],
      });
    const replacement = await system.auth.issue({
      accountId: author.accountId,
      clientId,
      scopes: system.auth.ordinaryScopes,
    });
    expect(replacement.bearer).not.toBe(author.bearer);
    // Also cover replacement after the final source query, before disclosure.
    for (const occurrence of [1, 2])
      await withheld(
        path,
        author.bearer,
        async (request) => {
          request.headers.set('authorization', `Bearer ${replacement.bearer}`);
        },
        occurrence,
      );
    const reopened = await fixture.call('GET', path, { bearer: replacement.bearer });
    expect(reopened.response.status).toBe(200);
    expect(reopened.value?.viewer).toMatchObject({ affectedAuthor: true, appeal: { state: 'permitted' } });
    expect(reopened.text).not.toContain(replacement.bearer);
    expect(reopened.response.headers.get(SESSION_HEADER)).not.toBeNull();
  }, 120_000);
}

for (const change of ['revoke', 'suspend'] as const) {
  test(`a delegated author loses an in-flight decision on principal ${change}`, async () => {
    const { system, author } = fixture;
    const principal = await accountDeletionRuntime(system).person();
    await fixture.grant(principal.accountId, ['account:manage'], principal.accountId);
    const credential = await system.auth.issue({
      accountId: principal.accountId,
      clientId: system.auth.ordinaryClient.id,
      scopes: system.auth.ordinaryScopes,
    });
    // Assignment has no mounted creation route yet. Use its native command with
    // the installed self-management action and real principal authentication.
    const commands = createDelegationCommands({
      pool: system.database.pool,
      access: system.access,
      action: 'account:manage',
    });
    const context = async () => {
      const boundary = { pool: system.database.pool, deadline: Date.now() + 30_000 };
      return { ...boundary, actor: await system.access.authenticate(credential.bearer, boundary) };
    };
    const input = {
      principalId: principal.accountId,
      assignedActorId: author.accountId,
      requestId: newId(routeOf(principal.accountId)!),
      valid: '(,)',
      key: crypto.randomUUID(),
    };
    const assignment = await commands.create(await context(), input);
    const delegated = await system.auth.issue({
      accountId: author.accountId,
      clientId: system.auth.ordinaryClient.id,
      scopes: system.auth.ordinaryScopes,
      requestedBy: assignment.value.requestedBy,
    });
    const { path } = await decision(`Delegated principal ${change}`);
    // Advice must not be the only session gate: this branch already has an appeal.
    await fixture.command('POST', `${path}:appeal`, { statement: 'Pending delegated lifetime' });
    expect((await fixture.call('GET', path, { bearer: delegated.bearer })).response.status).toBe(200);
    await withheld(path, delegated.bearer, async () => {
      if (change === 'revoke') await commands.revoke(await context(), { ...input, key: crypto.randomUUID() });
      else
        await fixture.command(
          'POST',
          `/v1/accounts/${principal.accountId}:suspend`,
          { reason: 'Principal retired' },
          {
            bearer: fixture.governance.bearer,
            expectedStatus: 200,
          },
        );
    });
    const denied = await fixture.call('GET', path, { bearer: delegated.bearer });
    expect(denied.response.status).toBe(401);
    expect(denied.response.headers.get(SESSION_HEADER)).toBeNull();
    expect(denied.text).not.toContain('Private retained reason');
    const independent = await fixture.call('GET', path, { bearer: author.bearer });
    expect(independent.response.status).toBe(200);
    expect(independent.value?.viewer.appeal).toEqual({ state: 'unavailable', reason: 'already_appealed' });
  }, 120_000);
}

test('sparse retained provenance and an erased decider preserve only the unexpired statement', async () => {
  const { path, id, target } = await decision('Sparse retained decision');
  const read = () => fixture.call('GET', path, { bearer: fixture.author.bearer });
  await fixture.system.database.pool.query(
    `UPDATE content.moderation_decision SET recorded_transaction_id=NULL, board_id=NULL, decider_account_id=NULL
     WHERE route=$1 AND decision_id=$2`,
    [target.postRoute, id],
  );
  const retained = await read();
  expect(retained.response.status).toBe(200);
  expect(retained.value).toMatchObject({
    id,
    statement: 'Private retained reason',
    appeal: null,
    viewer: { affectedAuthor: true, appeal: { state: 'permitted' } },
    targetContext: { state: 'concealed' },
  });
  await fixture.system.database.pool.query(
    `UPDATE content.moderation_decision SET decided_at=CURRENT_TIMESTAMP - interval '184 days'
     WHERE route=$1 AND decision_id=$2`,
    [target.postRoute, id],
  );
  const expired = await read();
  expect(expired.response.status).toBe(200);
  expect(expired.value).toMatchObject({
    id,
    statement: '',
    appeal: null,
    viewer: { affectedAuthor: true, appeal: { state: 'unavailable', reason: 'deadline_passed' } },
  });
  expect(expired.response.headers.get(SESSION_HEADER)).not.toBeNull();
  expect(expired.text).not.toContain('Private retained reason');
  for (const result of [retained, expired]) {
    expect(result.value).not.toHaveProperty('decider_account_id');
    expect(result.value).not.toHaveProperty('recorded_transaction_id');
    expect(result.value).not.toHaveProperty('witness');
  }
}, 120_000);

test('native author erasure withholds an in-flight exact decision independently of appeal advice', async () => {
  const { path } = await decision('Erased exact author');
  await fixture.command('POST', `${path}:appeal`, { statement: 'Pending before erasure' });
  const { system, author } = fixture;
  const clientId = `decision_delete_${crypto.randomUUID()}`;
  const scopes = [...new Set([...system.auth.ordinaryScopes, 'account:delete'])];
  await system.nativeAuth.internal.registerClient({ clientId, firstParty: true, scopes });
  await system.auth.issue({ accountId: author.accountId, clientId, scopes });
  await withheld(path, author.bearer, async () => {
    await deletePersona({ pool: system.database.pool, auth: accountDeletionRuntime(system).auth }, author);
  });
  const denied = await fixture.call('GET', path, { bearer: author.bearer });
  expect(denied.response.status).toBe(401);
  expect(denied.response.headers.get(SESSION_HEADER)).toBeNull();
  expect(denied.text).not.toContain('Private retained reason');
}, 300_000);
