import { suspendAccount, reinstateAccount } from '../support/native-suspension-driver.ts';
import { AuthenticationError } from '../../src/request/access.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { fromPlainText } from '@rezics/document';
import { bundledRelease } from '@rezics/definitions/bundled';
import { bootstrapGovernance, PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { createGrantCommands, GrantDeniedError } from '../../src/access/grant-commands.ts';
import { installResourceRoleCatalogue, resourceRoleCatalogue } from '../../src/access/resource-roles.ts';
import { resourceAuthorization } from '../../src/access/resource-authorization.ts';
import { createSpace } from '../../src/community/space.ts';
import { createRealm } from '../../src/community/realm.ts';
import { setBoardScheme } from '../../src/community/board-scheme.ts';
import { createSubject, subjectTarget } from '../../src/semantic/subject.ts';
import { activeRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { setupSemantic } from '../../src/semantic/setup.ts';
import { globalContextAnchor } from '../../src/semantic/context.ts';
import { createBoard } from '../../src/content/board-create.ts';
import { createPost, createThread } from '../../src/content/commands.ts';
import { reserveMedia } from '../../src/content/media.ts';
import { erasePost, eraseStandaloneMedia, takedown } from '../../src/content/moderation.ts';
import { accessCheck, type Resource } from '../../src/request/access.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { standingFixture } from './standing-fixture.ts';

const routeKey = new Uint8Array(32).fill(83);
const action = 'moderation:takedown';
const extras = [
  'context:read',
  'realm:create',
  'realm:participate',
  'realm:join',
  'realm:read',
  'realm:manage',
  'realm:ban',
  'realm:publish',
  'space:create',
  'space:read',
  'space:manage',
  'board:create',
  'report:create',
  'reaction:set',
  'moderation:hide',
];

let fixture: Awaited<ReturnType<typeof standingFixture>>;
let staff: Awaited<ReturnType<typeof fixture.context>>['actor'];
let owner: Awaited<ReturnType<typeof fixture.context>>['actor'];
let board: Resource;
let threadId: string;
let firstPostId: string;
let secondPostId: string;
let mediaId: string;

function commandContext(idempotencyKey = crypto.randomUUID()) {
  return { idempotencyKey, deadline: Date.now() + 15_000, requestId: crypto.randomUUID() };
}

async function prepareSubject(item: unknown, key: string) {
  const current = await activeRelease(fixture.pool);
  if (!current) throw new Error('Bundled semantic release was not activated');
  const target = subjectTarget(routeKey, owner.accountId, key);
  const deadline = Date.now() + 15_000;
  const authorization = resourceAuthorization({
    access: fixture.access,
    actor: owner,
    action: 'subject:create',
    anchor: globalContextAnchor,
    context: { pool: fixture.pool, deadline, partition: partitionOf(target.route) },
  });
  return createSubject(fixture.pool, {
    actor: owner,
    target,
    idempotencyKey: key,
    digest: createHash('sha256').update(JSON.stringify(item)).digest(),
    item,
    release: current,
    authorization,
    deadline,
  });
}

async function check(
  actor: typeof staff,
  verb: string,
  resource: Resource,
  scopes?: readonly string[],
  requestedBy?: string,
) {
  const context = await fixture.context(actor.accountId, scopes === undefined ? undefined : [...scopes], requestedBy);
  const prepared = await accessCheck(fixture.access, context.actor, verb, resource, context);
  return prepared(fixture.pool);
}

async function reachRows() {
  return (
    await fixture.reader.query(
      `SELECT route,transaction_id::text,action,resource_id::text,actor_account_id::text
       FROM access.governance_reach ORDER BY transaction_id,action,resource_id`,
    )
  ).rows;
}

beforeAll(async () => {
  fixture = await standingFixture(extras);
  const catalogue = resourceRoleCatalogue(fixture.access);
  if (!catalogue) throw new Error('Fixture Access resource roles are unavailable');
  const declaredTypes = new Map(catalogue.declaredTypes ?? []);
  for (const [action, type] of [
    ['space:create', 'community.space'],
    ['realm:create', 'community.realm'],
    ['board:create', 'content.board'],
    ['media:create', 'content.media'],
  ] as const)
    declaredTypes.set(action, [type]);
  installResourceRoleCatalogue(fixture.access, { ...catalogue, declaredTypes });
  await fixture.reset();
  await bootstrapGovernance(fixture.pool, fixture.actor);
  await setupSemantic(fixture.pool, bundledRelease);
  staff = (await fixture.context(fixture.actor)).actor;
  owner = (await fixture.context(fixture.recipient)).actor;
  for (const granted of ['space:create', 'realm:create', 'context:read'])
    await fixture.grant(owner.accountId, granted, PLATFORM_RESOURCE);

  const scheme = await prepareSubject(
    { type: 'skos:ConceptScheme', labels: { en: 'Governance fixture' } },
    crypto.randomUUID(),
  );
  const concept = await prepareSubject(
    {
      type: 'skos:Concept',
      labels: { en: 'Governance board concept' },
      statements: {
        'skos:inScheme': [{ property: { id: 'skos:inScheme' }, value: { type: 'value', content: scheme.subject.id } }],
      },
    },
    crypto.randomUUID(),
  );
  for (const id of [scheme.subject.id, concept.subject.id]) {
    const subject = { route: routeOf(id)!, id };
    await fixture.grant(owner.accountId, 'subject:read', subject);
  }

  const space = await createSpace(
    { pool: fixture.pool, access: fixture.access, routeKey },
    owner,
    { title: 'Governance fixture space' },
    commandContext(),
  );
  const realm = await createRealm(
    { pool: fixture.pool, access: fixture.access, routeKey },
    owner,
    {
      spaceId: space.value.spaceId,
      title: 'Governance fixture realm',
      visibility: 'public',
      contextId: GLOBAL_CONTEXT,
    },
    commandContext(),
  );
  await setBoardScheme(
    { pool: fixture.pool, access: fixture.access, routeKey },
    owner,
    { realmId: realm.value.realmId, schemeId: scheme.subject.id, expectedHead: realm.value.revisionId },
    commandContext(),
  );
  const createdBoard = await createBoard(
    { pool: fixture.pool, access: fixture.access },
    owner,
    {
      realmId: realm.value.realmId,
      conceptId: concept.subject.id,
      title: 'Governance fixture board',
      visibility: 'published',
    },
    commandContext(),
  );
  board = { route: routeOf(createdBoard.value.boardId)!, id: createdBoard.value.boardId };
  const content = { pool: fixture.pool, access: fixture.access, routeKey };
  const thread = await createThread(
    content,
    owner,
    {
      title: 'Governance fixture thread',
      body: fromPlainText('Thread created by the ordinary board owner.'),
      licence: 'MIT',
      subjectIds: [],
      boardId: board.id,
      visibility: 'published',
    },
    commandContext(),
  );
  threadId = thread.value.threadId;
  firstPostId = thread.value.itemId;
  const post = await createPost(
    content,
    owner,
    {
      threadId,
      boardId: board.id,
      body: fromPlainText('A second post for governance checks.'),
      licence: 'MIT',
      subjectIds: [],
    },
    commandContext(),
  );
  secondPostId = post.value.itemId;
  const media = await reserveMedia(
    { pool: fixture.pool, access: fixture.access },
    owner,
    { containerId: threadId, purpose: 'post-image', mediaType: 'image/png', byteCount: 12 },
    commandContext(),
  );
  mediaId = media.value.mediaId;
}, 60_000);

afterAll(async () => fixture?.close());

test.serial(
  'platform governance reach is exact, recorded by commands, and retains ordinary Access floors',
  async () => {
    const post = (id: string): Resource => ({ route: routeOf(id)!, id });
    const postOne = post(firstPostId);
    const postTwo = post(secondPostId);
    const media = post(mediaId);
    for (const [resource, verb] of [
      [board, action],
      [postOne, action],
      [postTwo, 'post:erase'],
      [media, 'media:erase'],
    ] as const) {
      expect(
        await fixture.reader.query(
          `SELECT 1 FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$3 AND action=$4
         UNION ALL
         SELECT 1 FROM access.resource_role_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$3
           AND grant_role='platform.governance'`,
          [resource.route, resource.id, staff.accountId, verb],
        ),
      ).toMatchObject({ rowCount: 0 });
    }

    await fixture.reader.query(
      `INSERT INTO access.resource_denial
     (route,resource_id,subject_id,action,reason,valid,transaction_id)
     VALUES ($1,$2,$3,'moderation:takedown','realm_ban','(,)',$4)`,
      [postOne.route, postOne.id, staff.accountId, newId(postOne.route)],
    );
    const beforeOutside = await reachRows();
    expect(await check(staff, action, board)).toBe(true);
    expect(await check(staff, action, postOne)).toBe(true);
    expect(await check(staff, 'post:erase', postTwo)).toBe(true);
    expect(await check(staff, 'media:erase', media)).toBe(true);
    expect(await reachRows()).toEqual(beforeOutside);

    const exactActor = (await fixture.context(fixture.principal)).actor;
    await fixture.grant(exactActor.accountId, action, PLATFORM_RESOURCE);
    expect(await check(exactActor, action, postOne)).toBe(true);
    for (const other of ['moderation:hide', 'post:erase', 'media:erase', 'subject:read'])
      expect(await check(exactActor, other, postOne)).toBe(false);
    await fixture.grant(owner.accountId, 'moderation:hide', PLATFORM_RESOURCE);
    expect(await check(owner, 'moderation:hide', board)).toBe(false);

    expect(await check(staff, action, postOne, [])).toBe(false);
    const requestId = newId(routeOf(fixture.principal)!);
    const requestedBy = `urn:rezics:request:${fixture.principal}:${requestId}`;
    await fixture.reader.query(
      `INSERT INTO access.principal_assignment
       (route,principal_id,creator_principal_id,request_id,assigned_actor_id,valid,transaction_id)
     VALUES ($1,$2,$2,$3,$4,'(,)',$3)`,
      [routeOf(fixture.principal), fixture.principal, requestId, fixture.actor],
    );
    await fixture.reader.query(
      `DELETE FROM access.resource_grant
     WHERE route=0 AND resource_id=$1 AND subject_id=$2 AND action=$3`,
      [PLATFORM_RESOURCE.id, fixture.principal, action],
    );
    const delegatedContext = await fixture.context(fixture.actor, undefined, requestedBy);
    const delegatedCheck = await accessCheck(fixture.access, delegatedContext.actor, action, postOne, delegatedContext);
    expect(await delegatedCheck(fixture.pool)).toBe(false);
    await fixture.grant(fixture.principal, action, PLATFORM_RESOURCE);
    let delegatedAgain = await fixture.context(fixture.actor, undefined, requestedBy);
    expect(
      await (
        await accessCheck(fixture.access, delegatedAgain.actor, action, postOne, delegatedAgain)
      )(fixture.pool),
    ).toBe(true);

    const clientContext = await fixture.context(staff.accountId, []);
    const clientCheck = await accessCheck(fixture.access, clientContext.actor, action, postOne, clientContext);
    expect(await clientCheck(fixture.pool)).toBe(false);

    const context = { pool: fixture.pool, access: fixture.access, routeKey };
    const recordsBeforeFloors = await reachRows();
    staff = (await fixture.context(staff.accountId)).actor;
    const accountRoute = routeOf(staff.accountId)!;
    const originalAccount = (
      await fixture.reader.query(
        'SELECT minimum_authn_epoch,authn_fenced,state FROM access.account WHERE route=$1 AND account_id=$2',
        [accountRoute, staff.accountId],
      )
    ).rows[0]!;
    await fixture.reader.query('UPDATE access.account SET minimum_authn_epoch=$3 WHERE route=$1 AND account_id=$2', [
      accountRoute,
      staff.accountId,
      Number(originalAccount.minimum_authn_epoch) + 1,
    ]);
    await expect(
      takedown(
        context,
        staff,
        { target: { kind: 'post', id: firstPostId }, reason: 'Platform policy' },
        commandContext(),
      ),
    ).rejects.toBeInstanceOf(GrantDeniedError);
    staff = (await fixture.context(staff.accountId)).actor;
    delegatedAgain = await fixture.context(fixture.actor, undefined, requestedBy);
    for (const change of [
      { fenced: true, state: 'active' },
      { fenced: false, state: 'suspended' },
    ]) {
      if (change.state === 'suspended') await suspendAccount(fixture.pool, staff.accountId);
      else
        await fixture.reader.query(
          'UPDATE access.account SET authn_fenced=$3,state=$4 WHERE route=$1 AND account_id=$2',
          [accountRoute, staff.accountId, change.fenced, change.state],
        );
      await expect(
        takedown(
          context,
          staff,
          { target: { kind: 'post', id: firstPostId }, reason: 'Platform policy' },
          commandContext(),
        ),
      ).rejects.toBeInstanceOf(change.state === 'suspended' ? AuthenticationError : GrantDeniedError);
      if (change.state === 'suspended') {
        await reinstateAccount(fixture.pool, staff.accountId);
        staff = (await fixture.context(staff.accountId)).actor;
        delegatedAgain = await fixture.context(fixture.actor, undefined, requestedBy);
      } else
        await fixture.reader.query(
          "UPDATE access.account SET authn_fenced=false,state='active' WHERE route=$1 AND account_id=$2",
          [accountRoute, staff.accountId],
        );
      expect(await reachRows()).toEqual(recordsBeforeFloors);
    }
    const narrowStaff = (await fixture.context(staff.accountId, [])).actor;
    await expect(
      takedown(
        context,
        narrowStaff,
        { target: { kind: 'post', id: firstPostId }, reason: 'Platform policy' },
        commandContext(),
      ),
    ).rejects.toBeInstanceOf(GrantDeniedError);
    expect(await reachRows()).toEqual(recordsBeforeFloors);

    const takedownContext = commandContext();
    const takenDown = await takedown(
      context,
      delegatedAgain.actor,
      { target: { kind: 'post', id: firstPostId }, reason: 'Platform policy' },
      takedownContext,
    );
    expect(takenDown.replayed).toBe(false);
    expect(await reachRows()).toContainEqual({
      route: postOne.route,
      transaction_id: takenDown.transactionId,
      action,
      resource_id: postOne.id,
      actor_account_id: staff.accountId,
    });
    const rowsAfterTakedown = await reachRows();
    expect(
      (
        await takedown(
          context,
          delegatedAgain.actor,
          { target: { kind: 'post', id: firstPostId }, reason: 'Platform policy' },
          takedownContext,
        )
      ).replayed,
    ).toBe(true);
    expect(await reachRows()).toEqual(rowsAfterTakedown);

    const erasedPost = await erasePost(
      context,
      staff,
      { postId: secondPostId, reason: 'Platform policy' },
      commandContext(),
    );
    const erasedMedia = await eraseStandaloneMedia(
      context,
      staff,
      { mediaId, reason: 'Platform policy' },
      commandContext(),
    );
    expect(await reachRows()).toContainEqual({
      route: postTwo.route,
      transaction_id: erasedPost.transactionId,
      action: 'post:erase',
      resource_id: postTwo.id,
      actor_account_id: staff.accountId,
    });
    expect(await reachRows()).toContainEqual({
      route: media.route,
      transaction_id: erasedMedia.transactionId,
      action: 'media:erase',
      resource_id: media.id,
      actor_account_id: staff.accountId,
    });

    const grants = createGrantCommands({
      pool: fixture.pool,
      access: fixture.access,
      managementAction: 'access:grant',
    });
    await fixture.reader.query(`DELETE FROM access.resource_grant WHERE route=0 AND resource_id=$1 AND subject_id=$2`, [
      PLATFORM_RESOURCE.id,
      fixture.principal,
    ]);
    await fixture.grant(fixture.principal, 'access:grant', PLATFORM_RESOURCE);
    const grantor = (await fixture.context(fixture.principal)).actor;
    const grantContext = { pool: fixture.pool, actor: grantor, deadline: Date.now() + 15_000 };
    await expect(
      grants.create(grantContext, {
        resource: PLATFORM_RESOURCE,
        subject: { kind: 'account', id: fixture.recipient },
        actions: ['post:erase'],
        valid: '(,)',
        key: crypto.randomUUID(),
      }),
    ).rejects.toBeInstanceOf(GrantDeniedError);
    await fixture.grant(fixture.principal, 'post:erase', PLATFORM_RESOURCE);
    const authorizedGrantor = (await fixture.context(fixture.principal)).actor;
    const globalGrant = await grants.create(
      { pool: fixture.pool, actor: authorizedGrantor, deadline: Date.now() + 15_000 },
      {
        resource: PLATFORM_RESOURCE,
        subject: { kind: 'account', id: fixture.recipient },
        actions: ['post:erase'],
        valid: '(,)',
        key: crypto.randomUUID(),
      },
    );
    expect(globalGrant.replayed).toBe(false);

    const localTarget = fixture.resource;
    await fixture.grant(owner.accountId, action, localTarget);
    const localBefore = await reachRows();
    expect(await check(owner, action, localTarget)).toBe(true);
    expect(await reachRows()).toEqual(localBefore);

    const records = await reachRows();
    expect(records.every((row) => row.actor_account_id.length === 36)).toBe(true);
    expect(
      await fixture.reader.query('SELECT 1 FROM content.thread WHERE route=$1 AND thread_id=$2', [
        routeOf(threadId),
        threadId,
      ]),
    ).toMatchObject({ rowCount: 1 });
  },
  60_000,
);
