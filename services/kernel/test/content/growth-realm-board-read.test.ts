import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { CommunityDriver, CommunityGrowth } from '../../../../specs/community-driver.ts';
import { createCommunityDriver } from '../community/community-driver.ts';
import { checkGrowth } from '../support/growth.ts';

let driver: CommunityDriver;
let fixture: Awaited<ReturnType<CommunityDriver['provision']>>;
let growth: CommunityGrowth;

beforeAll(async () => {
  driver = await createCommunityDriver();
  fixture = await driver.provision();
  growth = await driver.growthFixture();
}, 90_000);

afterAll(async () => {
  await driver?.close();
});

async function readBoard(actor: typeof fixture.owner): Promise<Response> {
  return driver.request({ actor, method: 'GET', path: `/v1/boards/${growth.boardId}` });
}

test('Public Realm board point read stays within its bound as boards, members and grants grow', async () => {
  const expected = await readBoard(fixture.owner);
  expect(expected.status).toBe(200);
  const expectedBody = await expected.clone().json();
  const report = await checkGrowth(growth.database, {
    name: 'Public Realm board point read stays within its bound as boards, members and grants grow',
    scales: [256, 1024, 4096],
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: async (_db, scale, previous) => growth.grow(scale, previous),
    operation: async () => {
      const response = await readBoard(fixture.owner);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(expectedBody);
    },
  });
  expect(report.samples).toHaveLength(3);
});

test('Protected Realm board point read by a member stays within its bound as boards, members and grants grow', async () => {
  const expected = await readBoard(fixture.member);
  expect(expected.status).toBe(200);
  const expectedBody = await expected.clone().json();
  const report = await checkGrowth(growth.database, {
    name: 'Protected Realm board point read by a member stays within its bound as boards, members and grants grow',
    scales: [256, 1024, 4096],
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: async (_db, scale, previous) => growth.grow(scale, previous),
    operation: async () => {
      const response = await readBoard(fixture.member);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(expectedBody);
    },
  });
  expect(report.samples).toHaveLength(3);
});
