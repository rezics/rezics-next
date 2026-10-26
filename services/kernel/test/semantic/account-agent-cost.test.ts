import { afterAll, beforeAll, expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { principalCommandIdentity, runCommand } from '../../src/command/command.ts';
import { newId, partitionOf } from '../../src/route/route.ts';
import { AccountAgentWriteDeniedError, accountAgentId } from '../../src/semantic/agents.ts';
import { ensureAccountAgent } from '../../src/semantic/account-agents.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { assertAgentStatementAccess, readItemDetails } from '../../src/semantic/subject.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');

const route = 0x3450;
const owner = newId(route);
const agent = accountAgentId(owner);
const targetIds = Array.from({ length: 64 }, () => newId(route));
let db: GrowthDatabase;

beforeAll(async () => {
  db = await openGrowthDatabase(url);
  await bootstrapRelease(db.pool, bundledRelease);
  await ensureAccountAgent(db.pool, { account: owner, kind: 'person', name: 'Growth owner', language: 'en' });
});

afterAll(async () => {
  await db.close();
});

test('account agent ensure uses constant statements as account agents grow', async () => {
  const report = await checkGrowth(db, {
    name: 'account agent ensure uses constant statements as account agents grow',
    scales: [1, 8, 64],
    warmups: 1,
    bounds: { rows: 'linear', blocks: 'logarithmic', statements: 'constant' },
    grow: async (database, scale, previous) => {
      for (let ordinal = previous; ordinal < scale; ordinal++) {
        await ensureAccountAgent(database.pool, {
          account: newId(route),
          kind: 'person',
          name: `Growth ${ordinal}`,
          language: 'en',
        });
      }
    },
    operation: async (database) =>
      ensureAccountAgent(database.pool, {
        account: newId(route),
        kind: 'person',
        name: 'Growth measurement',
        language: 'en',
      }),
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([1, 8, 64]);
});

test('account agent ownership probe uses constant statements at targets 1, 8 and 64', async () => {
  const report = await checkGrowth(db, {
    name: 'account agent ownership probe uses constant statements at targets 1, 8 and 64',
    scales: [1, 8, 64],
    warmups: 1,
    bounds: { rows: 'linear', blocks: 'logarithmic', statements: 'constant' },
    grow: async (database, scale, previous) => {
      const additions = targetIds.slice(previous, scale);
      if (!additions.length) return;
      await database.admin.query(
        `INSERT INTO semantic.subject(route, subject_id, type, recorded_transaction_id)
         SELECT $1, subject_id, 'schema:Person', gen_random_uuid()
         FROM unnest($2::uuid[]) AS subject_id`,
        [route, additions],
      );
    },
    operation: async (database, scale) => {
      const ids = [agent, ...targetIds.slice(0, scale)];
      const actor = {
        kind: 'account' as const,
        accountId: newId(route),
        clientId: 'growth',
        scopes: [],
        requestedBy: null,
        authnEpoch: 1,
      };
      let denied = false;
      try {
        await runCommand(
          database.pool,
          { partition: partitionOf(route), ...principalCommandIdentity(actor) },
          async (tx) => {
            const details = await readItemDetails(tx, ids);
            expect(details.size).toBe(scale + 1);
            expect(details.get(agent)?.agentAccountId).toBe(owner);
            assertAgentStatementAccess(tx, ids, details);
            return { value: null, events: [] };
          },
        );
      } catch (error) {
        expect(error).toBeInstanceOf(AccountAgentWriteDeniedError);
        denied = true;
      }
      expect(denied).toBe(true);
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([1, 8, 64]);
});
