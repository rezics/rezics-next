import { afterAll, expect, test } from 'bun:test';
import type { Account, CommunityDriver } from '../../../../specs/community-driver.ts';
import { PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { eraseAccountRevisionsPage } from '../../src/community/account-erasure-revisions.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { accountDeletionRuntime, deletePersona, drainEffects } from '../support/account-deletion.ts';
import { checkGrowth, openGrowthDatabase } from '../support/growth.ts';
import { closeCommunityDrivers, communityFixtureRuntime, createCommunityDriver, worker } from './community-driver.ts';

afterAll(closeCommunityDrivers);

async function call(
  driver: CommunityDriver,
  actor: Account | null,
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: unknown,
  head?: string,
) {
  const response = await driver.request({
    actor,
    method,
    path,
    body,
    ...(method === 'GET' ? {} : { key: JSON.stringify(crypto.randomUUID()) }),
    ...(head ? { ifMatch: JSON.stringify(head) } : {}),
  });
  expect(response.status, await response.clone().text()).toBeLessThan(300);
  return response.json();
}

async function setup() {
  const driver = await createCommunityDriver();
  const fixture = await driver.provision();
  const { system } = communityFixtureRuntime();
  const deletion = accountDeletionRuntime(system);
  const persona = await deletion.person();
  const owner = { id: persona.accountId, bearer: persona.bearer };
  await system.database.pool.query(
    `INSERT INTO access.resource_grant (route, resource_id, subject_id, action, valid, transaction_id)
     SELECT $1, $2, $3, action, '(,)'::tstzrange, $3 FROM unnest($4::text[]) AS action
     ON CONFLICT DO NOTHING`,
    [PLATFORM_RESOURCE.route, PLATFORM_RESOURCE.id, owner.id, ['space:create', 'realm:create']],
  );
  const { space } = await call(driver, owner, 'POST', '/v1/spaces', {
    title: 'Original Space',
    summary: 'Space archive',
  });
  const { realm } = await call(driver, owner, 'POST', '/v1/realms', {
    spaceId: space.spaceId,
    contextId: fixture.contextId,
    visibility: 'public',
    title: 'Original Realm',
    summary: 'Realm archive',
  });
  return { driver, fixture, system, owner, space, realm };
}

async function eraseAll(
  pool: ReturnType<typeof communityFixtureRuntime>['system']['database']['pool'],
  accountId: string,
) {
  let after: string | null = null;
  let found = 0;
  do {
    const page = await eraseAccountRevisionsPage({ pool }, accountId, after);
    expect(page.found).toBeLessThanOrEqual(50);
    expect(page.pending).toBe(0);
    found += page.found;
    after = page.next;
  } while (after !== null);
  return found;
}

test("account erasure keeps each Realm's and Space's current revision with its author id and erases the account's archived revisions' authored text", async () => {
  const { driver, fixture, system, owner, space, realm } = await setup();
  const pool = system.database.pool;
  try {
    // Two edits by this editor, followed by an independent editor's head.
    const one = (
      await call(
        driver,
        owner,
        'PATCH',
        `/v1/realms/${realm.realmId}`,
        { title: 'First edit', summary: 'First archived prose' },
        realm.headRevisionId,
      )
    ).realm;
    const two = (
      await call(
        driver,
        owner,
        'PATCH',
        `/v1/realms/${realm.realmId}`,
        { title: 'Second edit', summary: 'Second archived prose' },
        one.headRevisionId,
      )
    ).realm;
    await call(driver, owner, 'POST', '/v1/roleGrants', {
      resource: { route: routeOf(realm.realmId), id: realm.realmId },
      subject: { kind: 'account', id: fixture.member.id },
      role: 'community.realm.owner',
      valid: '(,)',
    });
    const other = (
      await call(
        driver,
        fixture.member,
        'PATCH',
        `/v1/realms/${realm.realmId}`,
        { title: 'Other editor head', summary: 'Keep all of this' },
        two.headRevisionId,
      )
    ).realm;
    const currentSpace = (
      await call(
        driver,
        owner,
        'PATCH',
        `/v1/spaces/${space.spaceId}`,
        { title: 'Published Space', summary: 'Keep this Space' },
        space.headRevisionId,
      )
    ).space;
    // A second owner's Realm proves retention of a head authored by the deleted account too.
    const host = (await call(driver, owner, 'POST', '/v1/spaces', { title: 'Second Space' })).space;
    const ownHead = (
      await call(driver, owner, 'POST', '/v1/realms', {
        spaceId: host.spaceId,
        contextId: fixture.contextId,
        visibility: 'public',
        title: 'Published Realm',
        summary: 'Keep this Realm',
      })
    ).realm;
    await drainEffects(pool, partitionOf(routeOf(space.spaceId)!));
    await drainEffects(pool, partitionOf(routeOf(host.spaceId)!));
    await driver.settle();
    await expect(eraseAccountRevisionsPage({ pool }, owner.id, null)).rejects.toThrow();
    const archivedBefore = (
      await pool.query('SELECT * FROM community.realm_revision WHERE route=$1 AND realm_id=$2 ORDER BY revision_id', [
        routeOf(realm.realmId),
        realm.realmId,
      ])
    ).rows;
    const otherBefore = archivedBefore.find((row) => row.author === fixture.member.id);
    const spaceBefore = (
      await pool.query('SELECT * FROM community.space_revision WHERE route=$1 AND revision_id=$2', [
        routeOf(space.spaceId),
        space.headRevisionId,
      ])
    ).rows[0];
    const locatorBefore = (
      await pool.query('SELECT * FROM community.revision_locator WHERE route=$1 AND account_id=$2', [
        routeOf(owner.id),
        owner.id,
      ])
    ).rows;
    expect(locatorBefore).toHaveLength(7);
    const deletion = accountDeletionRuntime(system);
    await deletePersona(
      { pool: system.database.pool, auth: deletion.auth },
      { accountId: owner.id, bearer: owner.bearer },
    );
    await drainEffects(pool, partitionOf(routeOf(owner.id)!));
    expect(await eraseAll(pool, owner.id)).toBe(7);
    const archivedAfter = (
      await pool.query('SELECT * FROM community.realm_revision WHERE route=$1 AND realm_id=$2 ORDER BY revision_id', [
        routeOf(realm.realmId),
        realm.realmId,
      ])
    ).rows;
    expect(archivedAfter).toEqual(
      archivedBefore.map((row) => (row.author === owner.id ? { ...row, title: '', summary: '' } : row)),
    );
    expect(archivedAfter.find((row) => row.author === fixture.member.id)).toEqual(otherBefore);
    expect(
      (
        await pool.query('SELECT * FROM community.space_revision WHERE route=$1 AND revision_id=$2', [
          routeOf(space.spaceId),
          space.headRevisionId,
        ])
      ).rows,
    ).toEqual([{ ...spaceBefore, title: '', summary: '' }]);
    expect((await call(driver, fixture.member, 'GET', `/v1/spaces/${space.spaceId}`)).space).toEqual(currentSpace);
    expect((await call(driver, null, 'GET', `/v1/realms/${realm.realmId}`)).realm).toEqual(other);
    expect((await call(driver, null, 'GET', `/v1/realms/${ownHead.realmId}`)).realm).toEqual(ownHead);
    expect(ownHead.author).toBe(owner.id);
    expect(currentSpace.author).toBe(owner.id);
    expect(currentSpace.creator).toBe(owner.id);
    expect(ownHead.creator).toBe(owner.id);
    expect(
      (
        await pool.query('SELECT * FROM community.revision_locator WHERE route=$1 AND account_id=$2', [
          routeOf(owner.id),
          owner.id,
        ])
      ).rows,
    ).toEqual([]);
    expect(await eraseAccountRevisionsPage({ pool }, owner.id, null)).toEqual({
      found: 0,
      pending: 0,
      next: null,
    });
    // Ordinary SQL cannot rewrite history or use the erasure exception to change provenance.
    await expect(
      pool.query("UPDATE community.realm_revision SET title='Rewrite' WHERE route=$1 AND revision_id=$2", [
        routeOf(realm.realmId),
        one.headRevisionId,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
  } finally {
    await driver.close();
    await closeCommunityDrivers();
  }
}, 360000);

test("an account revision erasure page stays within its bound as other editors' revisions grow", async () => {
  const { driver, fixture, system, owner, space, realm } = await setup();
  const route = routeOf(realm.realmId)!;
  let db: Awaited<ReturnType<typeof openGrowthDatabase>> | undefined;
  try {
    await drainEffects(system.database.pool, partitionOf(route));
    await driver.settle();
    const admin = system.database.pool;
    const revisions = Array.from({ length: 1000 }, () => newId(route));
    await admin.query(
      `INSERT INTO community.realm_revision
      (route,realm_id,revision_id,predecessor,title,summary,visibility,context_id,created_at,author)
      SELECT $1,$2,id,$3,'Archived','Private prose','public',$4,now(),$5 FROM unnest($6::uuid[]) AS id`,
      [route, realm.realmId, realm.headRevisionId, fixture.contextId, owner.id, revisions],
    );
    await admin.query(
      `INSERT INTO community.revision_locator(route,account_id,kind,owner_route,owner_id,revision_id)
      SELECT $1,$2,'realm',$3,$4,id FROM unnest($5::uuid[]) AS id`,
      [routeOf(owner.id), owner.id, route, realm.realmId, revisions],
    );
    const deletion = accountDeletionRuntime(system);
    await deletePersona(
      { pool: system.database.pool, auth: deletion.auth },
      { accountId: owner.id, bearer: owner.bearer },
    );
    await drainEffects(system.database.pool, partitionOf(routeOf(owner.id)!));
    await driver.settle();
    await worker.stop();
    db = await openGrowthDatabase(system.database.pool.options.connectionString!);
    let after: string | null = null;
    const report = await checkGrowth(db, {
      name: "an account revision erasure page stays within its bound as other editors' revisions grow",
      rule: 'series',
      scales: [256, 1024, 4096],
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      async grow(database, scale, previous) {
        const ids = Array.from({ length: scale - previous }, () => newId(route));
        await database.admin.query(
          `INSERT INTO community.realm_revision
          (route,realm_id,revision_id,predecessor,title,summary,visibility,context_id,created_at,author)
          SELECT $1,$2,id,$3,'Other editor','Keep','public',$4,now(),$5 FROM unnest($6::uuid[]) AS id`,
          [route, realm.realmId, realm.headRevisionId, fixture.contextId, fixture.member.id, ids],
        );
        await database.admin.query(
          `INSERT INTO community.revision_locator(route,account_id,kind,owner_route,owner_id,revision_id)
          SELECT $1,$2,'realm',$3,$4,id FROM unnest($5::uuid[]) AS id`,
          [routeOf(fixture.member.id), fixture.member.id, route, realm.realmId, ids],
        );
        const population = await database.admin.query(
          'SELECT count(*)::integer AS n FROM community.realm_revision WHERE route=$1 AND realm_id=$2 AND author=$3',
          [route, realm.realmId, fixture.member.id],
        );
        expect(population.rows[0].n).toBe(scale);
      },
      async operation(database) {
        const page = await eraseAccountRevisionsPage({ pool: database.pool }, owner.id, after);
        expect(page.found).toBe(50);
        expect(page.pending).toBe(0);
        expect(page.next).not.toBeNull();
        after = page.next;
      },
    });
    expect(report.samples.map((sample) => sample.scale)).toEqual([256, 1024, 4096]);
    expect(new Set(report.samples.map((sample) => sample.cost.statements)).size).toBe(1);
    expect(
      (
        await db.admin.query('SELECT head_revision_id FROM community.space WHERE route=$1 AND space_id=$2', [
          route,
          space.spaceId,
        ])
      ).rows[0].head_revision_id,
    ).toBe(space.headRevisionId);
  } finally {
    await db?.close();
    await driver.close();
    await closeCommunityDrivers();
  }
}, 360000);
