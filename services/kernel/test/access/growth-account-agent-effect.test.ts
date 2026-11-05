import { afterAll, beforeAll, expect, test } from 'bun:test';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { applyAccountAgentEffect } from '../../src/access/account-agent-effect.ts';
import { accountAgentId } from '../../src/semantic/agents.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const route = 0x4534;
const targetAccount = newId(route);
let database: GrowthDatabase;

function activationEvent(accountId: string) {
  return {
    specversion: '1.0' as const,
    id: newId(route),
    source: `urn:rezics:log:${partitionOf(route)}.1`,
    type: 'com.rezics.access.actor-activated.v1',
    subject: accountId,
    time: '2026-10-27T00:00:00.000Z',
    datacontenttype: 'application/json' as const,
    sequence: '0000000000000000001',
    data: { accountId },
  };
}

beforeAll(async () => {
  database = await openGrowthDatabase();
  await bootstrapRelease(database.pool, bundledRelease);
  await database.admin.query(
    `INSERT INTO access.account(route, account_id, kind, handle, display_name, state, transaction_id)
     VALUES ($1, $2, 'actor', 'agent_growth_target', 'Growth target', 'active', $2)`,
    [route, targetAccount],
  );
  await applyAccountAgentEffect(database.pool, activationEvent(targetAccount));
});

afterAll(() => database?.close());

test('account agent effect growth stays within its bound at [256, 1024, 4096]', async () => {
  const event = activationEvent(targetAccount);
  const report = await checkGrowth(database, {
    name: 'account agent effect growth stays within its bound at [256, 1024, 4096]',
    scales: [256, 1024, 4096],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    warmups: 1,
    async grow(growth, scale, previous) {
      const count = scale - previous;
      const accounts = Array.from({ length: count }, () => newId(route));
      const agents = accounts.map(accountAgentId);
      for (let offset = 0; offset < count; offset += 1024) {
        const page = accounts.slice(offset, offset + 1024);
        const nodes = agents.slice(offset, offset + 1024);
        await growth.admin.query(
          `INSERT INTO access.account(route, account_id, kind, handle, display_name, state, transaction_id)
           SELECT $1, id, 'actor', 'growth_' || replace(id::text, '-', ''), 'Background ' || id::text, 'active', id
           FROM unnest($2::uuid[]) AS seed(id)`,
          [route, page],
        );
        await growth.admin.query(
          `INSERT INTO semantic.subject(route, subject_id, type, recorded_transaction_id, current_facts, current_release)
           SELECT $1, id, 'schema:Person', id, 0, $3 FROM unnest($2::uuid[]) AS seed(id)`,
          [route, nodes, bundledDigest],
        );
        await growth.admin.query(
          `INSERT INTO semantic.revision(route, subject_id, revision, kind, release, recorded_transaction_id)
           SELECT $1, id, 1, 'create', $3, id FROM unnest($2::uuid[]) AS seed(id)`,
          [route, nodes, bundledDigest],
        );
        await growth.admin.query(
          `INSERT INTO semantic.account_agent_subject(route, account_route, subject_id, account_id, agent_id)
           SELECT $1, $1, agent_id, account_id, agent_id
           FROM unnest($2::uuid[], $3::uuid[]) AS seed(account_id, agent_id)`,
          [route, page, nodes],
        );
      }
    },
    async operation(growth) {
      await applyAccountAgentEffect(growth.pool, event);
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([256, 1024, 4096]);
  for (const sample of report.samples) {
    expect(sample.cost.statements).toBeLessThan(20);
    expect(sample.cost.relations?.['access.account']?.rows).toBe(1);
    expect(sample.cost.relations?.['semantic.subject']?.rows).toBe(1);
  }
  expect(routeOf(accountAgentId(targetAccount))).toBe(route);
});
