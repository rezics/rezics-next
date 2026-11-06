import { afterAll, expect, test } from 'bun:test';
import type { Account, CommunityDriver, Fixture } from '../../../../specs/community-driver.ts';
import type { CloudEvent } from '../../src/events/log.ts';
import { PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { readErasureStatus, resolveRetention } from '../../src/access/erasure.ts';
import { createCommunityAccountErasureEffect } from '../../src/community/account-erasure.ts';
import { purgeAccountBanReasonsPage } from '../../src/community/account-erasure-records.ts';
import { banAccount } from '../../src/community/ban.ts';
import { createProductionAccess } from './membership-fixture.ts';
import { accountDeletionRuntime, deletePersona, drainEffects } from '../support/account-deletion.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { closeCommunityDrivers, communityFixtureRuntime, createCommunityDriver } from './community-driver.ts';

const DAY = 86_400_000;
const QUESTION_ID = '00000000-0000-7000-8000-000000000001';
const RETENTION_PURPOSE = 'Ban reasons kept for complaints by the banned person, open six months after each ban';
const key = () => JSON.stringify(crypto.randomUUID());
const document = (text: string) => ({
  version: 'rezics-document-v1',
  profile: 'text',
  doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
});

afterAll(closeCommunityDrivers);

async function setup() {
  const driver = await createCommunityDriver();
  const fixture = await driver.provision();
  const { system } = communityFixtureRuntime();
  const deletion = accountDeletionRuntime(system);
  const persona = await deletion.person();
  return { driver, fixture, system, deletion, persona, account: { id: persona.accountId, bearer: persona.bearer } };
}

async function native<T>(
  driver: CommunityDriver,
  actor: Account,
  method: 'POST' | 'PATCH' | 'PUT',
  path: string,
  body?: unknown,
  ifMatch?: string,
  statuses: readonly number[] = [200, 201, 202, 204],
): Promise<{ response: Response; value: T | null }> {
  const response = await driver.request({
    actor,
    method,
    path,
    key: key(),
    ...(body === undefined ? {} : { body }),
    ...(ifMatch === undefined ? {} : { ifMatch: JSON.stringify(ifMatch) }),
  });
  expect(statuses, await response.clone().text()).toContain(response.status);
  return { response, value: response.status === 204 ? null : ((await response.json()) as T) };
}

async function createRealm(driver: CommunityDriver, actor: Account, contextId: string, title: string) {
  const { value: spaceBody } = await native<{ space: { spaceId: string } }>(
    driver,
    actor,
    'POST',
    '/v1/spaces',
    { title: `${title} host`, summary: 'Erasure test host' },
    undefined,
    [201],
  );
  const spaceId = spaceBody!.space.spaceId;
  const { value } = await native<{ realm: { realmId: string; headRevisionId: string; creator: string } }>(
    driver,
    actor,
    'POST',
    '/v1/realms',
    { spaceId, title, summary: `${title} summary`, visibility: 'public', contextId },
    undefined,
    [201],
  );
  return value!.realm;
}

async function createBoard(driver: CommunityDriver, fixture: Fixture, realmId: string, head: string, actor: Account) {
  const schemeResponse = await native<{ subject: { id: string } }>(
    driver,
    fixture.subjectOwner,
    'POST',
    '/v1/subjects',
    { type: 'skos:ConceptScheme', labels: { en: 'Erasure board scheme' } },
    undefined,
    [201],
  );
  const schemeId = schemeResponse.value!.subject.id;
  const conceptResponse = await native<{ subject: { id: string } }>(
    driver,
    fixture.subjectOwner,
    'POST',
    '/v1/subjects',
    {
      type: 'skos:Concept',
      labels: { en: 'Erasure board' },
      statements: {
        'skos:inScheme': [{ property: { id: 'skos:inScheme' }, value: { type: 'value', content: schemeId } }],
      },
    },
    undefined,
    [201],
  );
  const assigned = await native<{ realm: { headRevisionId: string } }>(
    driver,
    actor,
    'PUT',
    `/v1/realms/${realmId}/boardScheme`,
    { schemeId },
    head,
    [200],
  );
  const created = await native<{ board: { id: string } }>(
    driver,
    actor,
    'POST',
    `/v1/realms/${realmId}/boards`,
    { conceptId: conceptResponse.value!.subject.id, title: 'Erasure notices', visibility: 'published' },
    undefined,
    [201],
  );
  return { boardId: created.value!.board.id, head: assigned.value!.realm.headRevisionId };
}

async function drain(driver: CommunityDriver, pool: import('pg').Pool, ids: string[]) {
  await driver.settle();
  for (const partition of new Set(ids.map((id) => partitionOf(routeOf(id)!))))
    await drainEffects(pool, partition, { deadlineMs: 120_000 });
  await driver.settle();
}

async function erase(state: Awaited<ReturnType<typeof setup>>, ids: string[]) {
  const result = await deletePersona(
    { version: 1, pool: state.system.database.pool, auth: state.deletion.auth },
    state.persona,
  );
  await drain(state.driver, state.system.database.pool, [...ids, state.persona.accountId]);
  return result;
}

async function waitUntil(predicate: () => Promise<boolean>, label: string, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(25);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function expectGlobalPending(status: Awaited<ReturnType<typeof readErasureStatus>>) {
  expect(status?.state).toBe('pending');
  expect(status?.completedAt).toBeNull();
}

test.serial(
  'deleting a member, editor, voter and notice recipient acknowledges community erased only after memberships, archived revisions, notices and rating rows are gone',
  async () => {
    const state = await setup();
    const { driver, fixture, system, account } = state;

    const globalGrant = await native(
      driver,
      fixture.subjectOwner,
      'POST',
      '/v1/grants',
      {
        resource: PLATFORM_RESOURCE,
        subject: { kind: 'account', id: account.id },
        actions: ['space:create', 'realm:create'],
        valid: '(,)',
      },
      undefined,
      [201],
    );
    expect(globalGrant.response.status).toBe(201);
    const editedRealm = await createRealm(driver, account, fixture.contextId, 'Account authored Realm');
    let head = editedRealm.headRevisionId;
    const board = await createBoard(driver, fixture, editedRealm.realmId, head, account);
    head = board.head;
    for (const title of ['First erased archive', 'Retained current head']) {
      const update = await native<{ realm: { headRevisionId: string } }>(
        driver,
        account,
        'PATCH',
        `/v1/realms/${editedRealm.realmId}`,
        { title, summary: `${title} summary` },
        head,
        [200],
      );
      head = update.value!.realm.headRevisionId;
    }

    const firstMemberRealm = await createRealm(driver, fixture.owner, fixture.contextId, 'First membership');
    const secondMemberRealm = await createRealm(driver, fixture.owner, fixture.contextId, 'Second membership');
    for (const realmId of [firstMemberRealm.realmId, secondMemberRealm.realmId]) {
      await native(driver, account, 'POST', `/v1/realms/${realmId}/membership`, undefined, undefined, [202, 204]);
    }

    const targetIds = new Set<string>([fixture.subject.id]);
    const targetPartitions = new Set([partitionOf(routeOf(fixture.subject.id)!)]);
    let serial = 0;
    while (targetPartitions.size < 3 && serial < 100) {
      const created = await native<{ subject: { id: string } }>(
        driver,
        fixture.subjectOwner,
        'POST',
        '/v1/subjects',
        { type: 'schema:Book', labels: { en: `Erasure vote target ${serial++}` } },
        undefined,
        [201],
      );
      const subjectId = created.value!.subject.id;
      const partition = partitionOf(routeOf(subjectId)!);
      if (!targetPartitions.has(partition)) {
        targetPartitions.add(partition);
        targetIds.add(subjectId);
      }
    }
    expect(targetPartitions.size).toBe(3);
    for (const subjectId of targetIds) {
      await native(
        driver,
        account,
        'PUT',
        `/v1/subjects/${subjectId}/ratings/${QUESTION_ID}/vote`,
        { units: 10 },
        undefined,
        [200],
      );
    }

    const threadCreated = await native<{ thread: { id: string; firstPost: { id: string } } }>(
      driver,
      account,
      'POST',
      '/v1/threads',
      {
        title: 'Notice recipient thread',
        body: document('The account should receive a reply notice.'),
        licence: 'MIT',
        subjectIds: [],
        boardId: board.boardId,
        visibility: 'published',
      },
      undefined,
      [201],
    );
    const thread = threadCreated.value!.thread;
    await native(
      driver,
      fixture.owner,
      'POST',
      `/v1/threads/${thread.id}/posts`,
      { body: document('A reply to the erased account.'), licence: 'MIT', parentId: thread.firstPost.id },
      undefined,
      [201],
    );
    await driver.settle();
    const noticeResult = await system.database.pool.query<{ notice_id: string }>(
      'SELECT notice_id::text FROM content.notice WHERE route=$1 AND recipient_id=$2 ORDER BY created_at,notice_id',
      [routeOf(account.id), account.id],
    );
    expect(noticeResult.rows.length).toBeGreaterThan(0);
    await native(driver, account, 'POST', `/v1/accounts/${account.id}/notifications:markSeen`, {
      through: noticeResult.rows.at(-1)!.notice_id,
    });

    await drain(driver, system.database.pool, [
      editedRealm.realmId,
      firstMemberRealm.realmId,
      secondMemberRealm.realmId,
      ...targetIds,
      thread.id,
    ]);
    const memberRows = await system.database.pool.query<{ realm_id: string }>(
      `SELECT realm_id::text FROM community.realm_member WHERE account_id=$1
       UNION ALL SELECT realm_id::text FROM community.realm_member_terminal WHERE account_id=$1`,
      [account.id],
    );
    expect(memberRows.rows.length).toBeGreaterThanOrEqual(2);
    expect(
      (await system.database.pool.query('SELECT 1 FROM rating.vote WHERE voter_id=$1', [account.id])).rowCount,
    ).toBe(targetIds.size);
    expect(
      (await system.database.pool.query('SELECT 1 FROM rating.voter_realm WHERE voter_id=$1', [account.id])).rowCount,
    ).toBeGreaterThanOrEqual(2);
    expect(
      (await system.database.pool.query('SELECT 1 FROM content.notice_seen WHERE account_id=$1', [account.id]))
        .rowCount,
    ).toBe(1);

    await erase(state, [
      editedRealm.realmId,
      firstMemberRealm.realmId,
      secondMemberRealm.realmId,
      ...targetIds,
      thread.id,
    ]);

    const status = await readErasureStatus(system.database.pool, account.id);
    expect(status?.participants.community?.outcome).toBe('erased');
    expectGlobalPending(status);
    expect(
      (
        await system.database.pool.query(
          `SELECT 1 FROM community.realm_member WHERE account_id=$1
           UNION ALL SELECT 1 FROM community.realm_member_terminal WHERE account_id=$1`,
          [account.id],
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (await system.database.pool.query('SELECT 1 FROM community.member_locator WHERE account_id=$1', [account.id]))
        .rowCount,
    ).toBe(0);
    expect(
      (await system.database.pool.query('SELECT 1 FROM community.revision_locator WHERE account_id=$1', [account.id]))
        .rowCount,
    ).toBe(0);
    const revisions = await system.database.pool.query<{
      revision_id: string;
      title: string;
      summary: string;
      author: string;
    }>(
      `SELECT revision_id::text,title,summary,author::text FROM community.realm_revision
       WHERE realm_id=$1 AND author=$2 ORDER BY created_at,revision_id`,
      [editedRealm.realmId, account.id],
    );
    const archived = revisions.rows.filter((revision) => revision.revision_id !== head);
    expect(archived.length).toBeGreaterThan(0);
    expect(archived.every((revision) => revision.title === '' && revision.summary === '')).toBe(true);
    const current = await system.database.pool.query<{
      creator: string;
      revision_id: string;
      title: string;
      summary: string;
      author: string;
    }>(
      `SELECT realm.creator::text, revision.revision_id::text, revision.title, revision.summary, revision.author::text
       FROM community.realm JOIN community.realm_revision revision
         ON revision.route=realm.route AND revision.realm_id=realm.realm_id AND revision.revision_id=realm.head_revision_id
       WHERE realm.realm_id=$1`,
      [editedRealm.realmId],
    );
    expect(current.rows[0]).toMatchObject({
      creator: account.id,
      revision_id: head,
      title: 'Retained current head',
      summary: 'Retained current head summary',
      author: account.id,
    });
    for (const statement of [
      'SELECT 1 FROM content.notice WHERE recipient_id=$1',
      'SELECT 1 FROM content.notice_seen WHERE account_id=$1',
      'SELECT 1 FROM rating.vote WHERE voter_id=$1',
      'SELECT 1 FROM rating.voter_realm WHERE voter_id=$1',
      'SELECT 1 FROM rating.population_vote WHERE voter_id=$1',
    ])
      expect((await system.database.pool.query(statement, [account.id])).rowCount, statement).toBe(0);
  },
  120_000,
);

test.serial('deleting an account with no community, rating or notice data acknowledges community none', async () => {
  const state = await setup();
  await erase(state, [state.persona.accountId]);
  const status = await readErasureStatus(state.system.database.pool, state.persona.accountId);
  expect(status?.participants.community?.outcome).toBe('none');
  expect(status?.participants.community?.retained).toEqual([]);
  expectGlobalPending(status);
});

test.serial('a replayed tombstone event neither repeats work nor acknowledges twice', async () => {
  const state = await setup();
  await erase(state, [state.persona.accountId]);
  const pool = state.system.database.pool;
  const eventRow = await pool.query<{
    partition_no: number;
    position: string;
    epoch: number;
    id: string;
    type: string;
    subject: string | null;
    data: unknown;
    recorded_at: Date;
  }>(
    `SELECT partition_no,position::text,epoch,id::text,type,subject,data,recorded_at
     FROM core.outbox WHERE type='com.rezics.access.account-tombstoned.v1' AND data->>'accountId'=$1
     ORDER BY position DESC,event_seq LIMIT 1`,
    [state.persona.accountId],
  );
  const row = eventRow.rows[0]!;
  const event = {
    specversion: '1.0',
    id: row.id,
    source: `urn:rezics:log:${row.partition_no}.${row.epoch}`,
    type: row.type,
    ...(row.subject === null ? {} : { subject: row.subject }),
    time: row.recorded_at.toISOString(),
    datacontenttype: 'application/json',
    sequence: row.position.padStart(19, '0'),
    data: row.data,
  } as CloudEvent;
  const progress = await pool.query<{ step: string; phase: string }>(
    'SELECT step::text,phase FROM community.account_erasure_progress WHERE route=$1 AND account_id=$2',
    [routeOf(state.persona.accountId), state.persona.accountId],
  );
  const acknowledgements = await pool.query<{ count: number }>(
    `SELECT count(*)::integer AS count FROM access.erasure_acknowledgement
     WHERE route=$1 AND account_id=$2 AND participant='community'`,
    [routeOf(state.persona.accountId), state.persona.accountId],
  );
  const connectionString = pool.options.connectionString;
  if (!connectionString) throw new Error('Community test database URL is missing');
  const work = await createWorkClient(connectionString);
  try {
    await createCommunityAccountErasureEffect({ client: work }).run(event);
    await state.driver.settle();
  } finally {
    await work.close();
  }
  expect(
    (
      await pool.query(
        'SELECT step::text,phase FROM community.account_erasure_progress WHERE route=$1 AND account_id=$2',
        [routeOf(state.persona.accountId), state.persona.accountId],
      )
    ).rows,
  ).toEqual(progress.rows);
  expect(
    (
      await pool.query(
        `SELECT count(*)::integer AS count FROM access.erasure_acknowledgement
         WHERE route=$1 AND account_id=$2 AND participant='community'`,
        [routeOf(state.persona.accountId), state.persona.accountId],
      )
    ).rows,
  ).toEqual(acknowledgements.rows);
  const status = await readErasureStatus(pool, state.persona.accountId);
  expect(status?.participants.community?.outcome).toBe('none');
  expectGlobalPending(status);
});

test.serial(
  "a moderator's recent ban reasons are acknowledged as one retention exception and resolved after the expiry purge",
  async () => {
    const state = await setup();
    const { driver, fixture, system, account } = state;
    const realm = await createRealm(driver, fixture.owner, fixture.contextId, 'Ban reason retention');
    expect((await driver.grantModerator(realm.realmId, account)).status).toBe(201);
    const actions = [...system.actions.keys()];
    const auth = await createProductionAccess({ actions });
    const actor = await auth.authenticate(system.database.pool, account.id, actions);
    const firstAt = new Date(Date.now() - 183 * DAY + 60_000);
    const secondAt = new Date(firstAt.getTime() + 30 * DAY);
    const context = () => ({ deadline: Date.now() + 30_000, idempotencyKey: crypto.randomUUID() });
    const ban = (target: Account, reason: string, at: Date) =>
      banAccount(
        {
          pool: system.database.pool,
          access: auth.access,
          routeKey: system.routeKey,
          clock: () => new Date(at),
          tokens: system.tokenKeys,
          workClient: async () => {
            throw new Error('A nonmember ban must not enqueue member removal');
          },
        },
        actor,
        { realmId: realm.realmId, accountId: target.id, reason },
        context(),
      );
    await ban(fixture.outsider, 'First retained reason', firstAt);
    await ban(fixture.member, 'Second retained reason', secondAt);
    await driver.settle();
    const starts = await system.database.pool.query<{ account_id: string; at: string }>(
      `SELECT account_id::text,lower(valid)::text AS at FROM community.realm_ban
       WHERE realm_id=$1 AND account_id=ANY($2::uuid[]) ORDER BY lower(valid)`,
      [realm.realmId, [fixture.outsider.id, fixture.member.id]],
    );
    expect(starts.rows).toHaveLength(2);
    const firstDue = new Date(Date.parse(starts.rows[0]!.at) + 183 * DAY).toISOString();
    const secondDue = new Date(Date.parse(starts.rows[1]!.at) + 183 * DAY).toISOString();
    expect(Date.parse(secondDue) - Date.parse(firstDue)).toBe(30 * DAY);

    await erase(state, [realm.realmId]);
    let status = await readErasureStatus(system.database.pool, account.id);
    expect(status?.participants.community?.outcome).toBe('erased');
    expect(status?.participants.community?.retained).toEqual([
      {
        store: 'community.realm_ban',
        fields: ['reason'],
        purpose: RETENTION_PURPOSE,
        expiresAt: secondDue,
        resolvedAt: null,
        overdue: false,
      },
    ]);
    expectGlobalPending(status);

    await waitUntil(async () => {
      const reasons = await system.database.pool.query<{ account_id: string; reason: string }>(
        `SELECT account_id::text,reason FROM community.realm_ban
         WHERE realm_id=$1 AND account_id=ANY($2::uuid[]) ORDER BY lower(valid)`,
        [realm.realmId, [fixture.outsider.id, fixture.member.id]],
      );
      return reasons.rows[0]?.reason === '' && reasons.rows[1]?.reason === 'Second retained reason';
    }, 'the first retained ban reason to expire');
    const afterFirst = await system.database.pool.query<{ account_id: string; reason: string }>(
      `SELECT account_id::text,reason FROM community.realm_ban
       WHERE realm_id=$1 AND account_id=ANY($2::uuid[]) ORDER BY lower(valid)`,
      [realm.realmId, [fixture.outsider.id, fixture.member.id]],
    );
    expect(afterFirst.rows.map((row) => row.reason)).toEqual(['', 'Second retained reason']);
    status = await readErasureStatus(system.database.pool, account.id);
    expect(status?.participants.community?.retained[0]?.resolvedAt).toBeNull();
    expectGlobalPending(status);

    let after: import('../../src/community/account-erasure-records.ts').CommunityRecordsCursor | null = null;
    do {
      const page = await purgeAccountBanReasonsPage(
        { clock: () => new Date(), pool: system.database.pool },
        account.id,
        {
          asOf: secondDue,
          after,
        },
      );
      after = page.next;
    } while (after !== null);
    await resolveRetention(
      { pool: system.database.pool, clock: () => new Date(secondDue) },
      { accountId: account.id, participant: 'community', store: 'community.realm_ban' },
    );
    const afterSecond = await system.database.pool.query<{ reason: string }>(
      `SELECT reason FROM community.realm_ban WHERE realm_id=$1 AND account_id=ANY($2::uuid[]) ORDER BY lower(valid)`,
      [realm.realmId, [fixture.outsider.id, fixture.member.id]],
    );
    expect(afterSecond.rows.map((row) => row.reason)).toEqual(['', '']);
    status = await readErasureStatus(system.database.pool, account.id);
    expect(status?.participants.community?.retained[0]?.resolvedAt).not.toBeNull();
    expectGlobalPending(status);
  },
  120_000,
);
