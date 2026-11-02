import { expect } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { createKernel } from '../../src/http/kernel.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { createNativeContentSystemWithWriteRateOverrides } from '../content/support/native-system.ts';
import { HIGH_RATE_OVERRIDES, seedGovernanceAuthority } from '../content/support/disclosure-fixtures.ts';
import type { ContentCredential } from '../content/support/system.ts';
import { configureTestReceiptKeys, testReceiptKeys } from '../support/receipt-keys.ts';
import { checkGrowth, openGrowthDatabase, seed, type Population } from '../support/growth.ts';

export const scales = [256, 1024, 4096] as const;
export const axes = ['population', 'history'] as const;
export type Axis = (typeof axes)[number];
export type Community = {
  space: { spaceId: string; headRevisionId: string };
  realm: { realmId: string; headRevisionId: string; contextId: string };
};

/** A separate native fixture, leaving the Home driver's population and composition intact. */
export async function containerGrowthFixture() {
  const system = await createNativeContentSystemWithWriteRateOverrides(
    { databaseUrl: process.env.DATABASE_URL! }, HIGH_RATE_OVERRIDES,
  );
  const db = await openGrowthDatabase(system.database.pool.options.connectionString!);
  configureTestReceiptKeys(db.pool);
  const owner = system.actors.other;
  const outsider = system.actors.author;
  await bootstrapRelease(db.pool, bundledRelease);
  await seedGovernanceAuthority(db.admin, 0, GLOBAL_CONTEXT, owner.actor.accountId, ['context:create']);
  // Every request and its Access/source reads use the shared observer's pool.
  const kernel = createKernel({
    pool: db.pool,
    access: system.access,
    routeKey: system.routeKey,
    tokens: system.tokenKeys,
    receiptKeys: testReceiptKeys(),
    writeRate: createWriteRateLimiter({
      secret: crypto.randomUUID() + crypto.randomUUID(), overrides: HIGH_RATE_OVERRIDES,
    }),
    ratePeer: () => '127.0.0.1',
  });
  async function call<T>(
    method: string, path: string, status: number, actor: ContentCredential | null = owner,
    body?: unknown, head?: string,
  ): Promise<T> {
    const response = await kernel.handle(new Request(`https://content.test${path}`, {
      method,
      headers: {
        ...(actor ? { authorization: `Bearer ${actor.bearer}` } : {}),
        ...(method === 'GET' ? {} : { 'idempotency-key': JSON.stringify(crypto.randomUUID()) }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(head === undefined ? {} : { 'if-match': JSON.stringify(head) }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    const value: unknown = await response.json();
    expect({ status: response.status, value }).toMatchObject({ status });
    return value as T;
  }
  async function community(visibility: 'public' | 'protected' = 'public'): Promise<Community> {
    const { context } = await call<{ context: { id: string } }>('POST', '/v1/contexts', 201, owner, {
      labels: { en: 'Independent growth Context' },
    });
    const { space } = await call<{ space: Community['space'] }>('POST', '/v1/spaces', 201, owner, {
      title: 'Fixed growth host',
    });
    const { realm } = await call<{ realm: Community['realm'] }>('POST', '/v1/realms', 201, owner, {
      spaceId: space.spaceId, contextId: context.id, visibility, title: 'Fixed growth Realm',
    });
    return { space, realm };
  }
  async function measure(name: string, selected: { space: Community['space']; realm?: Community['realm'] }, axis: Axis, operation: () => Promise<unknown>) {
    const route = routeOf(selected.space.spaceId)!;
    const actor = owner.actor.accountId;
    const at = '2020-01-01T00:00:00.000Z';
    const seriesId = crypto.randomUUID();
    const positionBase = Number((await db.admin.query('SELECT position FROM core.partition WHERE partition_no=$1', [partitionOf(route)])).rows[0].position);
    const population: Population = {
      name: `${name}-${axis}-${selected.space.spaceId}`,
      hotPartition: partitionOf(route), hotShare: 1,
      rows: ({ route: neighbourRoute, ordinal }) => {
        const rowRoute = axis === 'history' ? route : neighbourRoute;
        const spaceId = axis === 'history' ? selected.space.spaceId : newId(rowRoute);
        const realmId = axis === 'history' ? selected.realm?.realmId : newId(rowRoute);
        const spaceRevisions = Array.from({ length: 8 }, () => newId(rowRoute));
        const realmRevisions = Array.from({ length: 8 }, () => newId(rowRoute));
        const transactionId = crypto.randomUUID();
        const position = positionBase + ordinal * 100 + 1;
        const response = { spaceId, revisionId: spaceRevisions.at(-1) };
        return {
          ...(axis === 'population' ? {
            'community.space': [{ route: rowRoute, space_id: spaceId, state: 'active',
              head_revision_id: spaceRevisions.at(-1), created_at: at, creator: actor }],
            'access.resource_role_grant': [{ route: rowRoute, resource_id: spaceId, subject_kind: 'identity',
              subject_id: actor, grant_role: 'community.space.owner', valid: '(,)', transaction_id: transactionId }],
            'community.realm': [{ route: rowRoute, realm_id: realmId, space_id: spaceId, state: 'active',
              visibility: 'protected', context_id: GLOBAL_CONTEXT,
              head_revision_id: realmRevisions.at(-1), created_at: at, creator: actor }],
          } : {}),
          'core.receipt': [{ partition_no: partitionOf(route), principal_kind: 'account', principal_id: actor,
            command_kind: 'community.space.update', idempotency_key: `${seriesId}-${ordinal}`,
            request_digest: Buffer.alloc(32), epoch: 1, position, transaction_id: transactionId, response }],
          'core.outbox': [{ partition_no: partitionOf(route), position, event_seq: 0, event_count: 1, epoch: 1,
            id: crypto.randomUUID(), type: 'com.rezics.community.space.updated.v1', subject: spaceId, data: response }],
          'editorial.write_basis': [{ partition_no: partitionOf(route), transaction_id: transactionId, epoch: 1, position,
            principal_kind: 'account', principal_id: actor, client_id: owner.actor.clientId, requested_by: null, recorded_at: at }],
          'community.space_revision': spaceRevisions.map((revision_id, index) => ({
            route: rowRoute, space_id: spaceId, revision_id,
            predecessor: index ? spaceRevisions[index - 1] : null,
            title: 'Retained host revision', summary: '', created_at: at, author: actor,
          })),
          'community.realm_revision': realmId === undefined ? [] : realmRevisions.map((revision_id, index) => ({
            route: rowRoute, realm_id: realmId, revision_id,
            predecessor: index ? realmRevisions[index - 1] : null,
            title: 'Retained Realm revision', summary: '', visibility: 'protected', context_id: GLOBAL_CONTEXT,
            created_at: at, author: actor,
          })),
        };
      },
      async finish(admin) {
        await admin.query('UPDATE core.partition SET position=(SELECT max(position) FROM core.outbox WHERE partition_no=$1) WHERE partition_no=$1', [partitionOf(route)]);
      },
    };
    const report = await checkGrowth(db, {
      name: `${name} ${axis}`, scales,
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      async grow(_database, scale, previous) {
        await seed(db, population, { from: previous, to: scale });
        // Count persisted data and fence the selected heads independently of the seed loop.
        const count = await db.admin.query<{ count: number }>(
          axis === 'history'
            ? 'SELECT count(*)::integer AS count FROM community.space_revision WHERE route=$1 AND space_id=$2'
            : "SELECT count(*)::integer AS count FROM community.realm WHERE route BETWEEN $1 AND $1+15 AND realm_id<>$2",
          [axis === 'history' ? route : partitionOf(route) * 16, axis === 'history' ? selected.space.spaceId : selected.realm?.realmId ?? selected.space.spaceId],
        );
        expect(count.rows[0]!.count).toBeGreaterThanOrEqual(axis === 'history' ? scale * 8 : scale);
        for (const [kind, id, head] of [
          ['space', selected.space.spaceId, selected.space.headRevisionId],
          ...(selected.realm ? [['realm', selected.realm.realmId, selected.realm.headRevisionId]] : []),
        ]) {
          const current = await db.admin.query(
            `SELECT head_revision_id FROM community.${kind} WHERE route=$1 AND ${kind}_id=$2`,
            [routeOf(id!), id],
          );
          expect(current.rows).toEqual([{ head_revision_id: head }]);
        }
      },
      operation,
    });
    expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
    expect(new Set(report.samples.map(({ cost }) => cost.statements)).size).toBe(1);
    for (const { cost } of report.samples) {
      const community = Object.entries(cost.relations ?? {}).filter(([name]) => name.startsWith('community.'));
      expect(community.length).toBeGreaterThan(0);
      for (const [, relation] of community) expect(relation.sequentialScans).toBe(0);
    }
    return report;
  }
  return { system, db, owner, outsider, call, community, measure,
    async close() { await db.close(); await system.close(); },
  };
}
export type ContainerGrowthFixture = Awaited<ReturnType<typeof containerGrowthFixture>>;
