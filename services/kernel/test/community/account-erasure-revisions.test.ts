import { afterAll, expect, test } from 'bun:test';
import type { Pool, QueryResultRow } from 'pg';
import type { Account, CommunityDriver } from '../../../../specs/community-driver.ts';
import { PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { eraseAccountRevisionsPage } from '../../src/community/account-erasure-revisions.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { accountDeletionRuntime, deletePersona, drainEffects } from '../support/account-deletion.ts';
import { checkGrowth, openGrowthDatabase } from '../support/growth.ts';
import { closeCommunityDrivers, communityFixtureRuntime, createCommunityDriver, worker } from './community-driver.ts';

afterAll(closeCommunityDrivers);

type NativePool = Pick<Pool, 'connect'>;

function stageMarker(stage: string, event: string, detail?: unknown) {
  console.error(
    JSON.stringify({
      marker: 'account-erasure-revisions',
      stage,
      event,
      at: new Date().toISOString(),
      ...(detail === undefined ? {} : { detail }),
    }),
  );
}

async function nativeWaitEvidence(pool: NativePool, stage: string): Promise<void> {
  let client: Awaited<ReturnType<NativePool['connect']>> | undefined;
  try {
    client = await pool.connect();
    await client.query("SET application_name = 'account-erasure-revisions-diagnostic'");
    await client.query("SET statement_timeout = '2s'");
    const result = await client.query(`
      SELECT activity.pid,
             activity.application_name,
             activity.state,
             activity.wait_event_type,
             activity.wait_event,
             activity.query_start,
             activity.query,
             pg_blocking_pids(activity.pid) AS blocking_pids,
             COALESCE((
               SELECT json_agg(json_build_object(
                 'locktype', locks.locktype,
                 'mode', locks.mode,
                 'granted', locks.granted,
                 'relation', locks.relation,
                 'transactionid', locks.transactionid
               ))
                 FROM pg_locks AS locks
                WHERE locks.pid = activity.pid
             ), '[]'::json) AS locks
        FROM pg_stat_activity AS activity
       WHERE activity.datname = current_database()
         AND activity.pid <> pg_backend_pid()
         AND activity.application_name <> 'account-erasure-revisions-diagnostic'
         AND (activity.state <> 'idle' OR activity.wait_event_type IS NOT NULL)
       ORDER BY activity.query_start`);
    stageMarker(stage, 'native-wait-evidence', result.rows);
  } catch (error) {
    stageMarker(stage, 'native-wait-evidence-failed', error instanceof Error ? error.message : String(error));
  } finally {
    if (client) {
      try {
        await client.query('RESET statement_timeout');
        await client.query('RESET application_name');
      } catch {
        // A failed diagnostic connection is released below; its error is already in the stage trace.
      } finally {
        client.release();
      }
    }
  }
}

async function nativeStage<T>(
  enabled: boolean,
  stage: string,
  action: () => Promise<T>,
  pool?: NativePool,
): Promise<T> {
  if (!enabled) return action();
  stageMarker(stage, 'start');
  let diagnostic: Promise<void> | undefined;
  const timer = pool
    ? setInterval(() => {
        if (diagnostic) return;
        diagnostic = nativeWaitEvidence(pool, stage).finally(() => {
          diagnostic = undefined;
        });
      }, 5_000)
    : undefined;
  try {
    const result = await action();
    stageMarker(stage, 'done');
    return result;
  } catch (error) {
    stageMarker(stage, 'failed', error instanceof Error ? error.message : String(error));
    if (pool) await nativeWaitEvidence(pool, stage);
    throw error;
  } finally {
    if (timer) clearInterval(timer);
    await diagnostic;
  }
}

async function boundedFixtureQuery<T extends QueryResultRow = QueryResultRow>(
  pool: NativePool,
  label: string,
  statement: string,
  values: unknown[] = [],
) {
  const client = await pool.connect();
  try {
    await client.query("SET statement_timeout = '30s'");
    return await client.query<T>(statement, values);
  } catch (error) {
    stageMarker(label, 'fixture-query-failed', {
      statement,
      error: error instanceof Error ? error.message : String(error),
    });
    await nativeWaitEvidence(pool, label);
    throw error;
  } finally {
    try {
      await client.query('RESET statement_timeout');
    } catch {
      // Release the timed-out connection after preserving the original query failure.
    }
    client.release();
  }
}

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

async function setup(trace = false) {
  const driver = await nativeStage(trace, 'create community driver', () => createCommunityDriver());
  const { system } = communityFixtureRuntime();
  const fixture = await nativeStage(trace, 'provision community fixture', () => driver.provision(), system.database.pool);
  const deletion = accountDeletionRuntime(system);
  const persona = await nativeStage(trace, 'create deletable person', () => deletion.person(), system.database.pool);
  const owner = { id: persona.accountId, bearer: persona.bearer };
  const { space, realm } = await nativeStage(
    trace,
    'resource setup',
    async () => {
      await boundedFixtureQuery(
        system.database.pool,
        'grant create resource permissions',
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
      return { space, realm };
    },
    system.database.pool,
  );
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
  const { driver, fixture, system, owner, space, realm } = await setup(true);
  const route = routeOf(realm.realmId)!;
  let db: Awaited<ReturnType<typeof openGrowthDatabase>> | undefined;
  try {
    await nativeStage(true, 'pre-deletion drain effects', () => drainEffects(system.database.pool, partitionOf(route)), system.database.pool);
    await nativeStage(true, 'pre-deletion settle', () => driver.settle(), system.database.pool);
    const admin = system.database.pool;
    const revisions = Array.from({ length: 50 }, () => newId(route));
    await nativeStage(
      true,
      'revision and locator fixture inserts',
      async () => {
        await boundedFixtureQuery(
          admin,
          'insert archived revision fixtures',
          `INSERT INTO community.realm_revision
          (route,realm_id,revision_id,predecessor,title,summary,visibility,context_id,created_at,author)
          SELECT $1,$2,id,$3,'Archived','Private prose','public',$4,now(),$5 FROM unnest($6::uuid[]) AS id`,
          [route, realm.realmId, realm.headRevisionId, fixture.contextId, owner.id, revisions],
        );
        await boundedFixtureQuery(
          admin,
          'insert archived revision locators',
          `INSERT INTO community.revision_locator(route,account_id,kind,owner_route,owner_id,revision_id)
          SELECT $1,$2,'realm',$3,$4,id FROM unnest($5::uuid[]) AS id`,
          [routeOf(owner.id), owner.id, route, realm.realmId, revisions],
        );
      },
      system.database.pool,
    );
    const baseLocators = (
      await boundedFixtureQuery<{ n: number }>(
        admin,
        'count pre-existing owner revision locators',
        'SELECT count(*)::integer AS n FROM community.revision_locator WHERE route=$1 AND account_id=$2',
        [routeOf(owner.id), owner.id],
      )
    ).rows[0]!.n;
    expect(baseLocators).toBeGreaterThan(0);
    const deletion = accountDeletionRuntime(system);
    await nativeStage(
      true,
      'real deletePersona',
      () => deletePersona(
        { pool: system.database.pool, auth: deletion.auth },
        { accountId: owner.id, bearer: owner.bearer },
      ),
      system.database.pool,
    );
    await nativeStage(
      true,
      'deletion drain effects',
      () => drainEffects(system.database.pool, partitionOf(routeOf(owner.id)!)),
      system.database.pool,
    );
    await nativeStage(true, 'deletion settle', () => driver.settle(), system.database.pool);
    await nativeStage(true, 'worker.stop', () => worker.stop(), system.database.pool);
    db = await nativeStage(
      true,
      'openGrowthDatabase',
      () => openGrowthDatabase(system.database.pool.options.connectionString!),
      system.database.pool,
    );
    let after: string | null = null;
    const resetPage = async (database: Awaited<ReturnType<typeof openGrowthDatabase>>) => {
      await nativeStage(
        true,
        'reset revision erasure page fixtures',
        () =>
          boundedFixtureQuery(
            database.admin,
            'reinsert account revision locators',
            `INSERT INTO community.revision_locator(route,account_id,kind,owner_route,owner_id,revision_id)
            SELECT $1,$2,'realm',$3,$4,id FROM unnest($5::uuid[]) AS id ON CONFLICT DO NOTHING`,
            [routeOf(owner.id), owner.id, route, realm.realmId, revisions],
          ),
        system.database.pool,
      );
      after = null;
    };
    const report = await nativeStage(true, 'checkGrowth entry', () => checkGrowth(db!, {
      name: "an account revision erasure page stays within its bound as other editors' revisions grow",
      rule: 'series',
      scales: [256, 1024, 4096],
      repetitions: 1,
      warmups: 1,
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      async grow(database, scale, previous) {
        stageMarker(`grow scale ${scale}`, 'start', { previous });
        const ids = Array.from({ length: scale - previous }, () => newId(route));
        for (let offset = 0; offset < ids.length; offset += 256) {
          const batch = ids.slice(offset, offset + 256);
          await nativeStage(
            true,
            `grow scale ${scale}: revision rows ${offset + batch.length}/${ids.length}`,
            () =>
              boundedFixtureQuery(
                database.admin,
                `insert other editor revisions at ${scale} (${offset + batch.length}/${ids.length})`,
                `INSERT INTO community.realm_revision
                (route,realm_id,revision_id,predecessor,title,summary,visibility,context_id,created_at,author)
                SELECT $1,$2,id,$3,'Other editor','Keep','public',$4,now(),$5 FROM unnest($6::uuid[]) AS id`,
                [route, realm.realmId, realm.headRevisionId, fixture.contextId, fixture.member.id, batch],
              ),
            system.database.pool,
          );
          await nativeStage(
            true,
            `grow scale ${scale}: revision locators ${offset + batch.length}/${ids.length}`,
            () =>
              boundedFixtureQuery(
                database.admin,
                `insert other editor revision locators at ${scale} (${offset + batch.length}/${ids.length})`,
                `INSERT INTO community.revision_locator(route,account_id,kind,owner_route,owner_id,revision_id)
                SELECT $1,$2,'realm',$3,$4,id FROM unnest($5::uuid[]) AS id`,
                [routeOf(fixture.member.id), fixture.member.id, route, realm.realmId, batch],
              ),
            system.database.pool,
          );
        }
        const population = await nativeStage(
          true,
          `grow scale ${scale}: verify other editor revisions`,
          () =>
            boundedFixtureQuery<{ n: number }>(
              database.admin,
              `count other editor revisions at ${scale}`,
              'SELECT count(*)::integer AS n FROM community.realm_revision WHERE route=$1 AND realm_id=$2 AND author=$3',
              [route, realm.realmId, fixture.member.id],
            ),
          system.database.pool,
        );
        expect(population.rows[0].n).toBe(scale);
        stageMarker(`grow scale ${scale}`, 'done');
      },
      async operation(database) {
        const page = await eraseAccountRevisionsPage({ pool: database.pool }, owner.id, after);
        expect(page.found).toBe(50);
        expect(page.pending).toBe(0);
        expect(page.next).not.toBeNull();
        after = page.next;
      },
      async warmup(database) {
        await resetPage(database);
        const page = await eraseAccountRevisionsPage({ pool: database.pool }, owner.id, after);
        expect(page.found).toBe(50);
        after = page.next;
      },
      async prepare(database) {
        await resetPage(database);
      },
    }), system.database.pool);
    expect(report.samples.map((sample) => sample.scale)).toEqual([256, 1024, 4096]);
    expect(new Set(report.samples.map((sample) => sample.cost.statements)).size).toBe(1);
    expect(after).not.toBeNull();
    const continuation = await eraseAccountRevisionsPage({ pool: db.pool }, owner.id, after);
    expect(continuation).toEqual({ found: baseLocators, pending: 0, next: null });
    expect(await eraseAccountRevisionsPage({ pool: db.pool }, owner.id, continuation.next)).toEqual({
      found: 0,
      pending: 0,
      next: null,
    });
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
