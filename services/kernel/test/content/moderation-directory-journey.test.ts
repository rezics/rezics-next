import { afterAll, beforeAll, expect, test } from 'bun:test';
import { deriveAccess } from '../../src/access/derived-access.ts';
import type { AccountActor } from '../../src/request/access.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { testTokens } from '../support/test-kernel.ts';
import { realmBoardWorld } from './realm-board-create-support.ts';
import { observeNativeModerationScope } from '../../src/content/moderation-directory-source.ts';
import {
  createModerationDirectoryProjectionEffect,
  maintainModerationDirectoryPage,
  readModerationDirectoryReferences,
} from '../../src/content/moderation-directory-projection.ts';
import { readNativeModerationDirectory } from '../../src/content/moderation-directory.ts';
import type { ModerationDirectoryAuthorityReader } from '../../src/content/moderation-directory-authority.ts';

let w: Awaited<ReturnType<typeof realmBoardWorld>>;
let boardId: string;
let moderator: Awaited<ReturnType<typeof w.person>>;
let member: Awaited<ReturnType<typeof w.person>>;
const deadline = () => Date.now() + 30_000;
const deps = () => ({ clock: () => new Date(), pool: w.db.pool, access: w.kernel.testAccess, tokens: testTokens() });
const actor = (person = moderator): Promise<AccountActor> =>
  w.kernel.testAccess.authenticate(person.bearer, {
    pool: w.db.pool,
    deadline: deadline(),
  });
const scope = () => ({ kind: 'board' as const, id: boardId });
const observe = async (person = moderator) =>
  observeNativeModerationScope(deps(), await actor(person), scope(), deadline());
async function grant(id: string, person = moderator, valid = '(,)') {
  return w.checked('POST', '/v1/grants', {
    resource: { route: routeOf(id), id },
    subject: { kind: 'account', id: person.accountId },
    actions: ['moderation:read_reports'],
    valid,
  });
}
async function finishInstallation() {
  for (let page = 0; page < 32; page++) {
    if ((await maintainModerationDirectoryPage(w.db.pool)).state === 'complete') return;
  }
  throw new Error('Fixture baseline exceeded its bounded page budget');
}

beforeAll(async () => {
  w = await realmBoardWorld();
  moderator = await w.person();
  member = await w.person();
  const created = await w.board();
  expect(created.response.status).toBe(201);
  boardId = created.value.board.id;
  await grant(boardId);
  const organizationId = newId(0x8900);
  const held = await w.auth.bindings.internalLifecycle.reserveCoordination({
    accountId: w.owner.accountId,
    relatedAccountId: organizationId,
    purpose: 'membership',
    key: crypto.randomUUID(),
  });
  await w.auth.bindings.internalLifecycle.createOrganization({
    organizationId,
    ownerAccountId: w.owner.accountId,
    ownerReservationId: held.value.reservationId,
    key: crypto.randomUUID(),
  });
  const memberHold = await w.auth.bindings.internalLifecycle.reserveCoordination({
    accountId: member.accountId,
    relatedAccountId: organizationId,
    purpose: 'membership',
    key: crypto.randomUUID(),
  });
  const ownerActor = await w.auth.access.authenticate(w.owner.bearer, {
    pool: w.db.pool,
    deadline: deadline(),
  });
  await w.auth.bindings.lifecycle.setMembership(
    {
      actor: ownerActor,
      account: await readAccount(w.db.pool, routeOf(w.owner.accountId)!, w.owner.accountId),
      deadline: deadline(),
    },
    {
      organizationId,
      memberAccountId: member.accountId,
      reservationId: memberHold.value.reservationId,
      role: 'member',
      key: crypto.randomUUID(),
    },
  );
}, 120_000);
afterAll(async () => {
  await w?.close();
});

test('a direct native Board moderator needs no Realm membership; ordinary membership grants no queue', async () => {
  expect(await observe()).toMatchObject({
    item: {
      scope: scope(),
      label: 'Native Concept board',
      parent: { id: w.realm.realmId },
      queues: ['reports', 'appeals', 'resolved'],
      viewer: { open: 'permitted' },
    },
  });
  expect(await observe(member)).toBeNull();
  const queue = await w.call('GET', `/v1/boards/${boardId}/reports`, undefined, { bearer: moderator.bearer });
  expect(queue.response.status).toBe(200);
  expect(await observeNativeModerationScope(deps(), await actor(), { kind: 'catalogue' }, deadline())).toBeNull();
  await grant(GLOBAL_CONTEXT);
  expect(await observeNativeModerationScope(deps(), await actor(), { kind: 'catalogue' }, deadline())).toMatchObject({
    item: {
      scope: { kind: 'catalogue' },
      parent: null,
      queues: ['reports', 'resolved'],
    },
  });
});

test('native assembly remains unavailable without admitted authority currentness even after complete inventory', async () => {
  await finishInstallation();
  const result = await readNativeModerationDirectory(await actor(), { limit: 20 }, deps(), { deadline: deadline() });
  expect(result).toEqual({ state: 'unavailable', items: [], next: null });
});

test('a composed frontier permits native scopes, binds private continuation and retains sparse pages', async () => {
  await finishInstallation();
  // This exercises assembly and REAL native Access, not admission of a foreign
  // currentness source. The production seam above deliberately remains absent.
  const horizon = Date.now() + 60_000;
  const readModerationAuthority: ModerationDirectoryAuthorityReader = async () => ({
    epoch: 'fixture-cut',
    validUntil: horizon,
  });
  const native = { ...deps(), readModerationAuthority };
  const person = await actor();
  const context = { deadline: deadline(), credential: moderator.bearer };
  const first = await readNativeModerationDirectory(person, { limit: 1 }, native, context);
  expect(first).toMatchObject({
    state: 'ready',
    items: [{ scope: { kind: 'catalogue' } }],
  });
  if (first.state !== 'ready' || !first.next) throw new Error('Expected a native continuation');
  const next = await readNativeModerationDirectory(person, { limit: 1, cursor: first.next }, native, context);
  expect(next).toMatchObject({ state: 'ready', items: [{ scope: scope() }] });
  expect(
    await readNativeModerationDirectory(person, { limit: 1, cursor: first.next }, native, {
      ...context,
      credential: 'another-session',
    }),
  ).toEqual({ state: 'stale', items: [], next: null });
  const sparse = await readNativeModerationDirectory(await actor(member), { limit: 1 }, native, {
    deadline: deadline(),
  });
  expect(sparse).toMatchObject({ state: 'ready', items: [] });
});

test('bootstrap resumes a committed cursor, live registration supersedes baseline and duplicate delivery is safe', async () => {
  const original = (await w.db.admin.query('SELECT * FROM content.moderation_directory_install')).rows[0];
  await w.db.admin.query(
    `UPDATE content.moderation_directory_install SET complete=false,after_route=-1,
    after_id='00000000-0000-0000-0000-000000000000',cut_route=$1,cut_id=$2`,
    [routeOf(boardId), boardId],
  );
  expect(await readNativeModerationDirectory(await actor(), { limit: 1 }, deps())).toMatchObject({
    state: 'preparing',
  });
  await maintainModerationDirectoryPage(w.db.pool);
  await finishInstallation();
  const input = { limit: 20, deadline: deadline() };
  const before = await readModerationDirectoryReferences(w.db.pool, input);
  const event = (
    await w.db.admin.query(
      `SELECT id,'urn:rezics:log:'||partition_no||'.'||epoch AS source,type,subject,data,
    recorded_at::text AS time,lpad(position::text,19,'0') AS sequence,'1.0' AS specversion,
    'application/json' AS datacontenttype FROM core.outbox WHERE type='com.rezics.content.board.created.v1' AND subject=$1 LIMIT 1`,
      [boardId],
    )
  ).rows[0];
  // Delivery shape is reconstructed from the committed native outbox below.
  if (!event) throw new Error('Missing native Board registration');
  const effect = createModerationDirectoryProjectionEffect(w.db.pool);
  await effect.run(event);
  await effect.run(event);
  expect(await readModerationDirectoryReferences(w.db.pool, input)).toEqual(before);
  expect(before.references.some((row) => row.boardId === boardId)).toBe(true);
  expect(original).toBeDefined();
});

test('native final proof withholds a renamed source and a grant revoked between observations', async () => {
  let renamed = false;
  const base = w.kernel.testAccess;
  const changing = deriveAccess(base, {
    async prepare(person, action, resource, context) {
      if (!renamed && action === 'moderation:read_reports' && resource.id === boardId) {
        renamed = true;
        await w.db.admin.query(
          `UPDATE content.board SET title='Renamed native Board',security_revision=security_revision+1
          WHERE route=$1 AND board_id=$2`,
          [routeOf(boardId), boardId],
        );
      }
      return base.prepare?.(person, action, resource, context);
    },
  });
  expect(
    await observeNativeModerationScope({ ...deps(), access: changing }, await actor(), scope(), deadline()),
  ).toBeNull();
  const before = await observe();
  expect(before?.item.label).toBe('Renamed native Board');
  await w.checked(
    'POST',
    '/v1/grants/$revoke',
    {
      resource: { route: routeOf(boardId), id: boardId },
      subject: { kind: 'account', id: moderator.accountId },
      actions: ['moderation:read_reports'],
      valid: '(,)',
    },
    200,
  );
  expect(await observe()).toBeNull();
});
