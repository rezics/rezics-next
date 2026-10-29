import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { newId } from '../../src/route/route.ts';
import { ensureAccountAgent, accountAgentId } from '../../src/semantic/index.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { relationSlotForApi } from '../../src/semantic/item.ts';
import { labelOrderKey } from '../../src/semantic/link-keys.ts';
import { listSubjectLinks } from '../../src/semantic/links.ts';
import { withStatementReader } from '../../src/semantic/statement-disclosure.ts';
import {
  capture,
  checkGrowth,
  costOf,
  openGrowthDatabase,
  seed,
  type GrowthDatabase,
  type Population,
} from '../support/growth.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const route = 24000;
const owner = newId(route);
const outsider = newId(route);
const target = accountAgentId(owner);
const property = 'rezics:penNameOf';
let db: GrowthDatabase;
beforeAll(async () => {
  db = await openGrowthDatabase(url);
  await bootstrapRelease(db.pool, bundledRelease);
  await ensureAccountAgent(db.pool, { account: owner, kind: 'person', name: 'Private names' });
});
afterAll(async () => {
  await db.close();
});

// One scale unit is 32 complete private proposals, not an additive tail on a fixed table.
// N = 2048, 16384, 131072; all growing histories have the same 8x ratio.
const linksPerUnit = 32;
const population: Population = {
  name: 'semantic-private-statements',
  hotPartition: route >>> 4,
  rows: ({ ordinal, route: holderRoute, partition }) => {
    const subject = newId(holderRoute);
    const candidate = newId(holderRoute);
    const slot = relationSlotForApi(subject, property, bundledRelease.properties[property]!.relation, { target });
    const transactions = [randomUUID(), randomUUID()];
    const position = 1_000_000 + ordinal * 2;
    const statement = { rank: 'normal', value: { type: 'value', content: target }, qualifiers: [], references: [] };
    const identity = { route: holderRoute, subject_id: subject };
    const accepted = {
      ...identity,
      context_id: GLOBAL_CONTEXT,
      candidate_id: candidate,
      head: 1,
      verdict: 'accept',
      revision: 2,
    };
    return {
      'semantic.subject': [
        {
          ...identity,
          type: 'schema:Person',
          recorded_transaction_id: transactions[0],
          current_release: bundledDigest,
        },
      ],
      'semantic.revision': transactions.map((recorded_transaction_id, index) => ({
        ...identity,
        revision: index + 1,
        kind: index === 0 ? 'create' : 'propose',
        release: bundledDigest,
        recorded_transaction_id,
        source: index === 0 ? null : { kind: 'agent', subject: target },
      })),
      // The ordinary proposal expands an empty relation slot before installing its private candidate.
      'semantic.fact': [
        {
          ...identity,
          slot_id: slot,
          log_seq: 33,
          operation: 'expand',
          kind: 'statement',
          language: null,
          property,
          statement_id: null,
          body: {},
          recorded_transaction_id: transactions[1],
          release: null,
          relation: true,
        },
      ],
      'semantic.candidate': [
        {
          ...identity,
          candidate_id: candidate,
          slot_id: slot,
          property,
          rank: 'normal',
          statement,
          release: bundledDigest,
          revision: 2,
          origin: 'proposal',
          relation: true,
        },
      ],
      'semantic.acceptance': [accepted],
      'semantic.acceptance_current': [{ ...accepted, slot_id: slot }],
      'semantic.adoption': [
        {
          ...identity,
          slot_id: slot,
          context_id: GLOBAL_CONTEXT,
          head: 1,
          mode: 'replace',
          selection: [{ candidate, rank: 'normal' }],
          revision: 2,
        },
      ],
      'semantic.statement_disclosure': [
        {
          ...identity,
          candidate_id: candidate,
          target_id: target,
          account_id: owner,
          property,
          disclosed: false,
          source_order_key: labelOrderKey({}),
          target_order_key: labelOrderKey({ en: 'Private names' }),
        },
      ],
      'core.receipt': transactions.map((transaction_id, index) => ({
        partition_no: partition,
        principal_kind: 'account',
        principal_id: owner,
        command_kind: index === 0 ? 'subject.create' : 'statement.propose',
        idempotency_key: transaction_id,
        request_digest: new Uint8Array(32),
        epoch: 1,
        position: position + index,
        transaction_id,
        response: index === 0 ? { id: subject } : { candidate, revision: 2 },
      })),
      'core.outbox': [
        {
          partition_no: partition,
          position,
          event_seq: 0,
          event_count: 1,
          epoch: 1,
          id: newId(holderRoute),
          type: 'com.rezics.subject.created.v1',
          subject,
          data: { id: subject },
        },
        ...['com.rezics.subject.revised.v1', 'com.rezics.statement.proposed.v1'].map((type, event_seq) => ({
          partition_no: partition,
          position: position + 1,
          event_seq,
          event_count: 2,
          epoch: 1,
          id: newId(holderRoute),
          type,
          subject,
          data: event_seq === 0 ? { id: subject, revision: 2, kind: 'propose' } : { candidate, revision: 2 },
        })),
      ],
      'editorial.write_basis': transactions.map((transaction_id, index) => ({
        partition_no: partition,
        transaction_id,
        epoch: 1,
        position: position + index,
        principal_kind: 'account',
        principal_id: owner,
        client_id: 'growth-private-statements',
        requested_by: null,
      })),
    };
  },
  async finish(admin) {
    await admin.query(`UPDATE core.partition p SET position = history.position
      FROM (SELECT partition_no, max(position) AS position FROM core.outbox GROUP BY partition_no) history
      WHERE p.partition_no = history.partition_no AND p.position < history.position`);
  },
};

function nodes(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== 'object') return [];
  const node = value as Record<string, unknown>;
  return [...(typeof node['Node Type'] === 'string' ? [node] : []), ...nodes(node.Plan), ...nodes(node.Plans)];
}

async function operation(database: GrowthDatabase) {
  const page = await withStatementReader({ account: outsider, moderator: async () => false }, () =>
    listSubjectLinks(
      database.pool,
      { current: 1, keys: new Map([[1, new Uint8Array(32).fill(1)]]) },
      {
        subject: target,
        property,
        limit: 20,
        authorize: async () => true,
        seen: [],
        caughtUp: true,
        release: bundledRelease,
      },
    ),
  );
  expect(page.links).toEqual([]);
  expect(page.count).toEqual({ value: 0, exact: true });
}

test('public inverse rows stay flat with 64, 512 and 4096 private pen-name links', async () => {
  const populations: { scale: number; privateLinks: number }[] = [];
  const report = await checkGrowth(db, {
    name: 'public inverse rows stay flat with private pen-name links',
    scales: [64, 512, 4096],
    rule: 'series',
    warmups: 1,
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    async grow(database, scale, previous) {
      await seed(database, population, { from: linksPerUnit * previous, to: linksPerUnit * scale });
      const result = await database.admin.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM semantic.statement_disclosure
         WHERE target_id = $1 AND account_id = $2 AND NOT disclosed`,
        [target, owner],
      );
      const privateLinks = Number(result.rows[0]!.count);
      expect(privateLinks).toBe(linksPerUnit * scale);
      populations.push({ scale, privateLinks });
    },
    async warmup(database, scale) {
      // Capture the existing warm-up, without another run or an EXPLAIN of a substitute query.
      const { capture: raw } = await capture(database, () => operation(database));
      const cost = costOf(raw);
      const disclosureNodes = nodes(raw.plans).filter(
        (node) =>
          node['Relation Name'] === 'statement_disclosure' || node['Index Name'] === 'statement_disclosure_inbound',
      );
      console.info(JSON.stringify({ scale, privateLinks: linksPerUnit * scale, warmup: cost, disclosureNodes }));
      try {
        const audience = disclosureNodes.filter((node) => node['Index Name'] === 'statement_disclosure_inbound');
        expect(audience).toHaveLength(1);
        expect(audience[0]!['Actual Loops']).toBe(1);
        const condition = String(audience[0]!['Index Cond']);
        expect(condition).toContain(`target_id = '${target}'::uuid`);
        expect(condition).toContain(`account_id = '${outsider}'::uuid`);
        expect(cost.relations['semantic.statement_disclosure']?.rows).toBe(0);
        expect(cost.relations['semantic.statement_disclosure']?.sequentialScans).toBe(0);
        expect(cost.statements).toBe(6);
      } catch (error) {
        // Keep the actual query and complete native plan when the audience derivation fails.
        console.error(JSON.stringify(raw));
        throw error;
      }
    },
    operation,
  });
  expect(report.samples.map((row) => row.scale)).toEqual([64, 512, 4096]);
  // This is narrow source-cost evidence; the existing audience/authorization fixture is not native Auth/API proof.
  console.info(JSON.stringify({ populations, ...report }));
  for (const sample of report.samples) {
    for (const cost of sample.repetitions) {
      expect(cost.statements).toBe(6);
      // Zero examined rows includes returned, filtered and index-rechecked disclosure rows, not just empty output.
      expect(cost.relations['semantic.statement_disclosure']?.rows).toBe(0);
      expect(cost.relations['semantic.statement_disclosure']?.sequentialScans).toBe(0);
    }
  }
});
