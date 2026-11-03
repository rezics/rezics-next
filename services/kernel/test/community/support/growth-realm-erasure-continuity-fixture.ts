import { expect } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { PLATFORM_RESOURCE } from '../../../src/access/bootstrap-governance.ts';
import { newId, partitionOf, routeOf } from '../../../src/route/route.ts';
import { GLOBAL_CONTEXT, bootstrapRelease } from '../../../src/semantic/definitions.ts';
import { createNativeContentSystemWithWriteRateOverrides } from '../../content/support/native-system.ts';
import { HIGH_RATE_OVERRIDES, seedGovernanceAuthority } from '../../content/support/disclosure-fixtures.ts';
import { accountDeletionRuntime, deletePersona } from '../../support/account-deletion.ts';
import { configureTestReceiptKeys } from '../../support/receipt-keys.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../../support/growth.ts';

export type RealmProbe = Readonly<{
  realmId: string;
  headRevisionId: string;
  route: number;
}>;

export type RealmErasureContinuityFixture = Readonly<{
  system: Awaited<ReturnType<typeof createNativeContentSystemWithWriteRateOverrides>>;
  db: GrowthDatabase;
  accountId: string;
  erasedAt: string;
  ordinary: RealmProbe;
  removed: RealmProbe;
  history: RealmProbe;
  close(): Promise<void>;
}>;

async function responseValue<T>(response: Response, status: number): Promise<T> {
  const value: unknown = await response.json();
  expect({ status: response.status, value }).toMatchObject({ status });
  return value as T;
}

export async function createRealmErasureContinuityFixture(): Promise<RealmErasureContinuityFixture> {
  const system = await createNativeContentSystemWithWriteRateOverrides(
    { databaseUrl: process.env.DATABASE_URL! },
    HIGH_RATE_OVERRIDES,
  );
  let db: GrowthDatabase | undefined;
  try {
    db = await openGrowthDatabase(system.database.pool.options.connectionString!);
    configureTestReceiptKeys(db.pool);
    await bootstrapRelease(db.pool, bundledRelease);

    const runtime = accountDeletionRuntime(system);
    const person = await runtime.person();
    await seedGovernanceAuthority(db.admin, PLATFORM_RESOURCE.route, PLATFORM_RESOURCE.id, person.accountId, [
      'space:create',
      'realm:create',
    ]);
    const at = new Date().toISOString();
    await system.clock.setCommandTime(at);

    async function call(method: string, path: string, body?: unknown, head?: string): Promise<Response> {
      return system.kernel.handle(
        new Request(`https://content.test${path}`, {
          method,
          headers: {
            authorization: `Bearer ${person.bearer}`,
            ...(method === 'GET' ? {} : { 'idempotency-key': JSON.stringify(crypto.randomUUID()) }),
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            ...(head === undefined ? {} : { 'if-match': JSON.stringify(head) }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
    }

    const { space } = await responseValue<{ space: { spaceId: string } }>(
      await call('POST', '/v1/spaces', { title: 'Realm erasure growth host' }),
      201,
    );
    async function createRealm(title: string): Promise<RealmProbe> {
      const { realm } = await responseValue<{ realm: { realmId: string; headRevisionId: string } }>(
        await call('POST', '/v1/realms', {
          spaceId: space.spaceId,
          title,
          visibility: 'public',
          contextId: GLOBAL_CONTEXT,
        }),
        201,
      );
      const route = routeOf(realm.realmId);
      if (route === null) throw new Error('Native Realm has no route');
      return { realmId: realm.realmId, headRevisionId: realm.headRevisionId, route };
    }

    const ordinary = await createRealm('Ordinary erasure growth Realm');
    const removed = await createRealm('Removed erasure growth Realm');
    const history = await createRealm('Retained history growth Realm');
    const { container } = await responseValue<{
      container: { version: string; headRevisionId: string };
    }>(await call('GET', `/v1/realms/${removed.realmId}/lifecycle`), 200);
    await responseValue(
      await call(
        'POST',
        `/v1/realms/${removed.realmId}/removal`,
        { expectedVersion: container.version, reason: 'Native erasure continuity growth' },
        container.headRevisionId,
      ),
      200,
    );

    const erased = await deletePersona({ pool: db.pool, auth: runtime.auth }, person);
    expect(erased.accountId).toBe(person.accountId);
    const erasedRoot = await db.admin.query<{ version: number; at: string }>(
      'SELECT version,at::text FROM access.erasure WHERE route=$1 AND account_id=$2',
      [routeOf(person.accountId), person.accountId],
    );
    expect(erasedRoot.rows).toHaveLength(1);
    expect(Date.parse(erasedRoot.rows[0]!.at)).toBe(Date.parse(erased.at));

    let closed = false;
    return {
      system,
      db,
      accountId: person.accountId,
      erasedAt: erased.at,
      ordinary,
      removed,
      history,
      async close() {
        if (closed) return;
        closed = true;
        await db!.close();
        await system.close();
      },
    };
  } catch (error) {
    await db?.close().catch(() => undefined);
    await system.close().catch(() => undefined);
    throw error;
  }
}

export function unrelatedRealmErasurePopulation(fixture: RealmErasureContinuityFixture) {
  const accounts: string[] = [];
  const population = {
    name: `realm-erasure-continuity-unrelated-${fixture.accountId}`,
    hotPartition: partitionOf(fixture.ordinary.route),
    hotShare: 1,
    rows({ route, ordinal }: { route: number; ordinal: number }) {
      const accountId = newId(route);
      const realmId = newId(route);
      const resourceId = newId(route);
      accounts[ordinal] = accountId;
      return {
        'access.resource_role_grant': [
          {
            route,
            resource_id: resourceId,
            subject_kind: 'identity',
            subject_id: accountId,
            subject_role: '',
            grant_role: 'community.realm.owner',
            valid: '[2020-01-01T00:00:00.000Z,)',
            transaction_id: crypto.randomUUID(),
          },
        ],
        'community.realm_member': [
          {
            route,
            realm_id: realmId,
            account_id: accountId,
            role: 'member',
            valid: '[2020-01-01T00:00:00.000Z,)',
            reservation_id: newId(route),
            transaction_id: crypto.randomUUID(),
          },
        ],
        'community.account_erasure_progress': [
          {
            route,
            account_id: accountId,
            step: ordinal,
            phase: 'complete',
            erased_at: fixture.erasedAt,
          },
        ],
        'access.erasure_progress': [
          {
            route,
            account_id: accountId,
            store: 'community',
            role: 'membership',
            partition_no: partitionOf(route),
            cursor: null,
            state: 'discovered',
            last_page: ordinal,
            result: null,
          },
        ],
      };
    },
  };
  return { population, accounts };
}

export function retainedRealmHistoryPopulation(fixture: RealmErasureContinuityFixture) {
  const revisions: string[] = [];
  const population = {
    name: `realm-erasure-continuity-history-${fixture.accountId}`,
    hotPartition: partitionOf(fixture.ordinary.route),
    hotShare: 1,
    rows({ route, ordinal }: { route: number; ordinal: number }) {
      const revisionId = newId(route);
      revisions[ordinal] = revisionId;
      return {
        'community.realm_revision': [
          {
            route,
            realm_id: fixture.history.realmId,
            revision_id: revisionId,
            predecessor: fixture.history.headRevisionId,
            title: `Retained revision ${ordinal}`,
            summary: '',
            visibility: 'public',
            context_id: GLOBAL_CONTEXT,
            created_at: fixture.erasedAt,
            author: fixture.accountId,
          },
        ],
      };
    },
  };
  return { population, revisions };
}
