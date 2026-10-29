import { afterAll, beforeAll, expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { principalCommandIdentity, runCommand } from '../../src/command/command.ts';
import { newId, partitionOf } from '../../src/route/route.ts';
import { AccountAgentWriteDeniedError, accountAgentId, accountAgentsForSubjects } from '../../src/semantic/agents.ts';
import { ensureAccountAgent } from '../../src/semantic/account-agents.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { assertAgentStatementAccess, readItemDetails } from '../../src/semantic/subject.ts';
import { capture, checkGrowth, costOf, openGrowthDatabase, settle, type GrowthDatabase } from '../support/growth.ts';

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

test('native target widths 1, 8 and 64 probe exact account-agent keys as unrelated accounts grow', async () => {
  const nativeRoute = 0x3470;
  const subjects = Array.from({ length: 64 }, () => newId(nativeRoute));
  const accounts = subjects.map(() => newId(nativeRoute));
  await db.admin.query(
    `INSERT INTO semantic.subject(route, subject_id, type, recorded_transaction_id)
     SELECT $1, id, 'schema:Person', gen_random_uuid() FROM unnest($2::uuid[]) AS id`,
    [nativeRoute, subjects],
  );
  await db.admin.query(
    `INSERT INTO semantic.account_agent_subject
       (route, subject_id, account_route, account_id, agent_id, verified, receipt_id)
     SELECT $1, subject, $1, account, subject, ordinal % 2 = 0,
            CASE WHEN ordinal % 2 = 0 THEN 'native-verification' ELSE NULL END
     FROM unnest($2::uuid[], $3::uuid[]) WITH ORDINALITY AS requested(subject, account, ordinal)`,
    [nativeRoute, subjects, accounts],
  );
  let previous = 0;
  for (const population of [500, 2000, 8000]) {
    const unrelated = Array.from({ length: population - previous }, () => newId(nativeRoute));
    await db.admin.query(
      `INSERT INTO semantic.subject(route, subject_id, type, recorded_transaction_id)
       SELECT $1, id, 'schema:Person', gen_random_uuid() FROM unnest($2::uuid[]) AS id`,
      [nativeRoute, unrelated],
    );
    await db.admin.query(
      `INSERT INTO semantic.account_agent_subject(route, subject_id, account_route, account_id, agent_id)
       SELECT $1, subject, $1, account, subject
       FROM unnest($2::uuid[], $3::uuid[]) AS requested(subject, account)`,
      [nativeRoute, unrelated, unrelated.map(() => newId(nativeRoute))],
    );
    previous = population;
    await settle(db, { analyze: true });
    for (const width of [1, 8, 64]) {
      const ids = subjects.slice(0, width);
      const measured = await capture(
        db,
        async () => ({
          details: await readItemDetails(db.pool, ids),
          agents: await accountAgentsForSubjects(db.pool, ids),
        }),
        { includeBackends: true },
      );
      console.info(`ACCOUNT_AGENT_NATIVE_PLANS ${JSON.stringify({ population, width, capture: measured.capture })}`);
      expect(measured.value.details.size).toBe(width);
      expect(measured.value.agents.size).toBe(width);
      for (let index = 0; index < width; index++) {
        const detail = measured.value.details.get(ids[index]!)!;
        expect(detail.agentAccountId).toBe(accounts[index]!);
        expect(detail.agentVerified).toBe(index % 2 === 1);
        expect(measured.value.agents.get(ids[index]!)?.verified).toBe(index % 2 === 1);
      }
      const cost = costOf(measured.capture);
      expect(cost.statements).toBe(2);
      expect(cost.relations['semantic.account_agent_subject']?.rows).toBeLessThanOrEqual(2 * width);
      let probes = 0;
      const visit = (node: Record<string, unknown>) => {
        if (node['Relation Name'] === 'account_agent_subject') {
          probes++;
          expect(node['Node Type']).toMatch(/^Index (Only )?Scan$/);
          expect(node['Index Cond']).toMatch(/route =/);
          expect(node['Index Cond']).toMatch(/subject_id =/);
          expect(Number(node['Actual Rows']) + Number(node['Rows Removed by Filter'] ?? 0)).toBeLessThanOrEqual(1);
          expect(Number(node['Actual Loops'])).toBeLessThanOrEqual(width);
        }
        for (const child of (node.Plans ?? []) as Record<string, unknown>[]) visit(child);
      };
      for (const document of measured.capture.plans) visit((document as { Plan: Record<string, unknown> }).Plan);
      expect(probes).toBe(2);
    }
  }
});
