import { expect, test } from 'bun:test';
import type { Account, Realm, Space } from '../../../../specs/community-driver.ts';
import type { BanReviewPage } from '../../src/community/ban-review-page-schemas.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import {
  assertGrowthAccessPaths,
  capture,
  checkGrowth,
  openGrowthDatabase,
  seed,
  settle,
  type Population,
} from '../support/growth.ts';
import { createCommunityDriver, closeCommunityDrivers, communityFixtureRuntime } from './community-driver.ts';
import {
  aggregateBanReviewPageCapture,
  banReviewPageWireCounts,
} from './support/ban-review-page-capture.ts';

function serializedRequestBytes(request: Request): number {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  if (!headers.has('host')) headers.set('host', url.host);
  const text = `${request.method} ${url.pathname}${url.search} HTTP/1.1\r\n${[...headers]
    .map(([name, value]) => `${name}: ${value}\r\n`)
    .join('')}\r\n`;
  return new TextEncoder().encode(text).byteLength;
}

function serializedResponseBytes(response: Response, body: string): number {
  const text = `HTTP/1.1 ${response.status} ${response.statusText}\r\n${[...response.headers]
    .map(([name, value]) => `${name}: ${value}\r\n`)
    .join('')}\r\n${body}`;
  return new TextEncoder().encode(text).byteLength;
}

async function recordJwksBytes(
  value: { jwksRequestBytes: number; jwksResponseBytes: number },
  request: Request,
  response: Response,
): Promise<void> {
  const body = await response.clone().text();
  value.jwksRequestBytes += serializedRequestBytes(request);
  value.jwksResponseBytes += serializedResponseBytes(response, body);
}

// Setup is native and completed before growth capture. A failed setup executes
// no measured operation; the harness refuses missing plans and charges controls.
test('mounted current bans keep exact current-key and Accounts paths as independent histories grow', async () => {
  let authGrowth: Awaited<ReturnType<typeof openGrowthDatabase>> | undefined;
  const driver = await createCommunityDriver({
    authPoolFactory: async (databaseUrl) => {
      authGrowth = await openGrowthDatabase(databaseUrl);
      return { pool: authGrowth.pool, close: authGrowth.close };
    },
  });
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
    if (!authGrowth) throw new Error('Growth fixture did not instrument the production Auth database');
    await settle(authGrowth, { relations: [] });
    growth = await openGrowthDatabase(system.database.pool.options.connectionString!);
    const db = growth,
      authDb = authGrowth,
      route = routeOf(realm.realmId)!;
    async function readCaptured(
      actor: Account = f.owner,
      suffix = '',
      selectedAccountId = targets[1]!,
    ) {
      const network = { jwksRequestBytes: 0, jwksResponseBytes: 0 };
      const selectedAccess = system.createFreshAccess((request, response) =>
        recordJwksBytes(network, request, response),
      );
      const kernel = system.createKernelForPool(db.pool, selectedAccess);
      const request = new Request(
        `https://content.test${path}?limit=1&selectedAccountId=${selectedAccountId}${suffix}`,
        { headers: { authorization: `Bearer ${actor.bearer}` } },
      );
      const observed = await capture(
        authDb,
        async () => {
          const response = await kernel.handle(request);
          const body = await response.text();
          return {
            status: response.status,
            page: JSON.parse(body) as BanReviewPage,
            applicationResponseBytes: serializedResponseBytes(response, body),
          };
        },
        { includeBackends: true },
      );
      expect(observed.value.status).toBe(200);
      return {
        page: observed.value.page,
        authCapture: observed.capture,
        applicationRequestBytes: serializedRequestBytes(request),
        applicationResponseBytes: observed.value.applicationResponseBytes,
        jwksRequestBytes: network.jwksRequestBytes,
        jwksResponseBytes: network.jwksResponseBytes,
      };
    }
    function expectSelectedPage(page: BanReviewPage) {
      expect(page.items.map((item) => item.accountId)).toEqual(targets.slice(0, 1));
      expect(page.selected).toMatchObject({
        state: 'current',
        ban: { accountId: targets[1], reason: 'Fixed admitted reason' },
      });
    }
    async function read(actor: Account = f.owner, suffix = '') {
      const observed = await readCaptured(actor, suffix);
      expectSelectedPage(observed.page);
      return observed.page;
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
      identities: {
        name: `ban-review-identities-${crypto.randomUUID()}`,
        hotPartition: partitionOf(route),
        hotShare: 1,
        rows: ({ route: home }) => ({
          'access.account': [
            { route: home, account_id: newId(home), kind: 'actor', state: 'active', transaction_id: newId(home) },
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
              transaction_id: newId(route),
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
        byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
        aggregateCaptures: aggregateBanReviewPageCapture,
        counted: {
          bounds: {
            applicationRequestBytes: 'constant',
            applicationResponseBytes: 'constant',
            jwksRequestBytes: 'constant',
            jwksResponseBytes: 'constant',
          },
          read: banReviewPageWireCounts,
        },
        grow: async (_, scale, previous) => {
          await seed(db, population, { from: previous, to: scale });
        },
        operation: async () => {
          const observed = await readCaptured();
          expectSelectedPage(observed.page);
          return observed;
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
    const deep = await readCaptured(
      f.owner,
      `&cursor=${encodeURIComponent(first.next!)}`,
      targets[0]!,
    );
    expect(deep.page).toMatchObject({
      items: [{ accountId: selected }],
      next: null,
      selected: { state: 'current', ban: { accountId: targets[0] } },
    });
  } finally {
    await growth?.close();
    await closeCommunityDrivers();
  }
}, 600_000);
