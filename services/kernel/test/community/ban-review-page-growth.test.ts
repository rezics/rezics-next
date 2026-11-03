import { expect, test } from 'bun:test';
import type { Account, Realm, Space } from '../../../../specs/community-driver.ts';
import type { BanReviewPage } from '../../src/community/ban-review-page-schemas.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { assertGrowthAccessPaths, checkGrowth, openGrowthDatabase, seed, type Population } from '../support/growth.ts';
import { createCommunityDriver, closeCommunityDrivers, communityFixtureRuntime } from './community-driver.ts';

// Setup is native and completed before growth capture. A failed setup executes
// no measured operation; the harness refuses missing plans and charges controls.
test('mounted current bans keep exact current-key and Accounts paths as independent histories grow', async () => {
  const driver = await createCommunityDriver();
  let growth: Awaited<ReturnType<typeof openGrowthDatabase>> | undefined;
  try {
    const f = await driver.provision();
    async function command<T>(method: 'POST' | 'PUT', path: string, body: unknown): Promise<T> {
      const response = await driver.request({
        method,
        path,
        body,
        actor: f.owner,
        key: JSON.stringify(crypto.randomUUID()),
      });
      expect([200, 201]).toContain(response.status);
      return response.json() as Promise<T>;
    }
    const { space } = await command<{ space: Space }>('POST', '/v1/spaces', { title: 'Growth ban host' });
    const { realm } = await command<{ realm: Realm }>('POST', '/v1/realms', {
      spaceId: space.spaceId,
      title: 'Growth operational bans',
      visibility: 'protected',
      contextId: f.contextId,
    });
    const path = `/v1/realms/${realm.realmId}/bans`;
    const targets = [f.member.id, f.outsider.id].sort();
    for (const target of targets) await command('PUT', `${path}/${target}`, { reason: 'Fixed admitted reason' });
    await driver.settle();
    const { system } = communityFixtureRuntime();
    growth = await openGrowthDatabase(system.database.pool.options.connectionString!);
    const db = growth,
      route = routeOf(realm.realmId)!;
    const kernel = createKernel({
      pool: db.pool,
      routeKey: system.routeKey,
      tokens: system.tokenKeys,
      access: system.access,
    });
    async function read(actor: Account = f.owner, suffix = '') {
      const response = await kernel.handle(
        new Request(`https://content.test${path}?limit=1&selectedAccountId=${targets[1]}${suffix}`, {
          headers: { authorization: `Bearer ${actor.bearer}` },
        }),
      );
      expect(response.status).toBe(200);
      const page = (await response.json()) as BanReviewPage;
      expect(page.items.map((item) => item.accountId)).toEqual(targets.slice(0, 1));
      expect(page.selected).toMatchObject({
        state: 'current',
        ban: { accountId: targets[1], reason: 'Fixed admitted reason' },
      });
      return page;
    }
    const selected = targets[1]!;
    const populations: Record<string, Population> = {
      unrelated: {
        name: `ban-review-unrelated-${crypto.randomUUID()}`,
        hotPartition: partitionOf(route),
        rows: ({ route: other }) => ({
          'community.realm_ban': [
            {
              route: other,
              realm_id: newId(other),
              account_id: newId(other),
              valid: '[2000-01-01,)',
              reason: 'Fixed unrelated payload',
              actor: f.owner.id,
              transaction_id: newId(other),
            },
          ],
        }),
      },
      intervals: {
        name: `ban-review-history-${crypto.randomUUID()}`,
        hotPartition: partitionOf(route),
        rows: ({ ordinal }) => ({
          'community.realm_ban': [
            {
              route,
              realm_id: realm.realmId,
              account_id: selected,
              valid: `[${new Date(Date.UTC(2000, 0, 1) + ordinal * 1000).toISOString()},${new Date(Date.UTC(2000, 0, 1) + (ordinal + 1) * 1000).toISOString()})`,
              reason: 'Closed episode',
              actor: f.owner.id,
              transaction_id: newId(route),
            },
          ],
        }),
      },
      authority: {
        name: `ban-review-authority-${crypto.randomUUID()}`,
        hotPartition: partitionOf(route),
        rows: ({ ordinal }) => ({
          'access.resource_grant': [
            {
              route,
              resource_id: realm.realmId,
              subject_kind: 'identity',
              subject_id: f.owner.id,
              subject_role: '',
              action: 'realm:ban',
              valid: `[${new Date(Date.UTC(2000, 0, 1) + ordinal * 1000).toISOString()},${new Date(Date.UTC(2000, 0, 1) + (ordinal + 1) * 1000).toISOString()})`,
            },
          ],
        }),
      },
    };
    for (const [axis, population] of Object.entries(populations)) {
      const name = `Realm ban review ${axis}`;
      const report = await checkGrowth(db, {
        name,
        scales: [256, 1024, 4096],
        bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
        grow: async (_, scale, previous) => {
          await seed(db, population, { from: previous, to: scale });
        },
        operation: async () => {
          await read();
        },
      });
      assertGrowthAccessPaths(name, report.samples, [
        { kind: 'relation', schema: 'community', name: 'realm_ban' },
        { kind: 'relation', schema: 'access', name: 'account' },
      ]);
      expect(report.samples.map((sample) => sample.scale)).toEqual([256, 1024, 4096]);
      for (const sample of report.samples) {
        for (const cost of Object.values(sample.cost.relations ?? {})) expect(cost.sequentialScans).toBe(0);
      }
    }
    // A deep page and an exact outside-page selection remain independent at the
    // largest retained scale. Native command readback changes the current episode.
    const first = await read();
    const deep = await kernel.handle(
      new Request(
        `https://content.test${path}?limit=1&cursor=${encodeURIComponent(first.next!)}&selectedAccountId=${targets[0]}`,
        {
          headers: { authorization: `Bearer ${f.owner.bearer}` },
        },
      ),
    );
    expect(deep.status).toBe(200);
    expect(await deep.json()).toMatchObject({
      items: [{ accountId: selected }],
      next: null,
      selected: { state: 'current', ban: { accountId: targets[0] } },
    });
  } finally {
    await growth?.close();
    await closeCommunityDrivers();
  }
}, 600_000);
