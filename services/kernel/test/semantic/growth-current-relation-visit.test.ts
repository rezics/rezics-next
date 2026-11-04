import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { currentRelationFacts } from '../../src/semantic/current-relations.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { itemFacts } from '../../src/semantic/item.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { writeFacts } from '../../src/semantic/write-facts.ts';
import { withReadTransaction } from '../../src/semantic/read.ts';
import { capture, openGrowthDatabase, type Capture, type GrowthDatabase } from '../support/growth.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

const route = 16000;
const property = 'schema:character';
const owner = newId(route);
const target = newId(route);
const routeKey = new Uint8Array(32).fill(29);
const transaction = newId(route);
const targetTransaction = newId(route);
const body = {
  property: { id: property },
  value: { type: 'value' as const, content: target },
  qualifiers: [],
  references: [],
};
const facts = itemFacts(owner, { type: 'schema:VideoGame', statements: { [property]: [body] } }, 'schema:VideoGame', bundledRelease);
const current = facts.find((fact) => fact.kind === 'statement')!;
const key = `${owner}\n${property}\n${current.statement_id}`;
let db: GrowthDatabase;

beforeAll(async () => {
  db = await openGrowthDatabase(databaseUrl!);
  await bootstrapRelease(db.pool, bundledRelease);
  await db.admin.query(
    `INSERT INTO semantic.subject
      (route, subject_id, type, recorded_transaction_id, visibility, security_revision, current_facts, current_release, projection_pending)
     VALUES ($1,$2,'schema:VideoGame',$3,'visible',0,0,$4,false),
            ($1,$5,'schema:Person',$6,'visible',0,0,$4,false)`,
    [route, owner, transaction, bundledDigest, target, targetTransaction],
  );
  await db.admin.query(
    `INSERT INTO semantic.revision (route, subject_id, revision, kind, release, recorded_transaction_id)
     VALUES ($1,$2,1,'create',$3,$4), ($1,$5,1,'create',$3,$6)`,
    [route, owner, bundledDigest, transaction, target, targetTransaction],
  );
  const client = await db.admin.connect();
  try {
    await writeFacts(client, {
      route,
      subject_id: owner,
      transaction_id: transaction,
      facts: facts.map((fact) => ({
        ...fact,
        release: fact.kind === 'statement' ? bundledDigest : null,
        relation: fact.kind === 'statement',
      })),
    });
  } finally {
    client.release();
  }
}, 120_000);

afterAll(async () => {
  await db?.close();
}, 60_000);

function nodes(value: unknown): Record<string, unknown>[] {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(nodes);
  const record = value as Record<string, unknown>;
  return [...(typeof record['Node Type'] === 'string' ? [record] : []), ...Object.values(record).flatMap(nodes)];
}

function examined(node: Record<string, unknown>): number {
  return (
    (Number(node['Actual Rows'] ?? 0) +
      Number(node['Rows Removed by Filter'] ?? 0) +
      Number(node['Rows Removed by Index Recheck'] ?? 0)) *
    Number(node['Actual Loops'] ?? 0)
  );
}

function assertBound(raw: Capture, scale: number) {
  const planNodes = raw.plans.flatMap(nodes);
  const scans = planNodes.filter((node) => ['subject', 'candidate', 'fact', 'revision'].includes(String(node['Relation Name'])));
  expect(scans.length).toBeGreaterThan(0);
  expect(scans.every((node) => !String(node['Node Type']).includes('Seq Scan'))).toBe(true);
  const currentKeys = planNodes.filter((node) => node['Index Name'] === 'fact_current_relation_key_seek');
  expect(currentKeys.length).toBeGreaterThan(0);
  for (const node of currentKeys) {
    for (const key of ['route', 'subject_id', 'slot_id', 'statement_id'])
      expect(String(node['Index Cond'])).toContain(key);
    expect(examined(node)).toBeLessThanOrEqual(1);
  }
  const subjectRows = scans.filter((node) => node['Relation Name'] === 'subject').reduce((n, node) => n + examined(node), 0);
  const candidateRows = scans.filter((node) => node['Relation Name'] === 'candidate').reduce((n, node) => n + examined(node), 0);
  const factRows = scans.filter((node) => node['Relation Name'] === 'fact').reduce((n, node) => n + examined(node), 0);
  const revisionRows = scans.filter((node) => node['Relation Name'] === 'revision').reduce((n, node) => n + examined(node), 0);
  expect(subjectRows).toBeLessThanOrEqual(1);
  expect(candidateRows).toBeLessThanOrEqual(1);
  expect(factRows).toBeLessThanOrEqual(8);
  expect(revisionRows).toBeLessThanOrEqual(2);
  for (const sort of planNodes.filter((node) => String(node['Node Type']).includes('Sort')))
    expect(examined(sort)).toBeLessThanOrEqual(3);
  console.info('Current relation keyed plan rows', { scale, subjectRows, candidateRows, factRows, revisionRows });
}

test('current relation key reads stay fixed across unrelated Subjects and obsolete selected-Subject revisions', async () => {
  const routeValue = routeOf(owner)!;
  let unrelated = 0;
  let obsolete = 0;
  const measures: (readonly [number, number])[] = [];
  for (const scale of [64, 512, 4096]) {
    const subjectIds = Array.from({ length: scale - unrelated }, () => newId(routeValue));
    if (subjectIds.length) {
      const unrelatedRows = subjectIds.map((subject_id) => ({ subject_id, transaction_id: newId(routeValue), slot_id: newId(routeValue) }));
      await db.admin.query(
        `WITH rows AS MATERIALIZED (
           SELECT subject_id, transaction_id, slot_id
           FROM jsonb_to_recordset($2::jsonb) AS row(subject_id uuid, transaction_id uuid, slot_id uuid)
         ), subjects AS (
           INSERT INTO semantic.subject
             (route, subject_id, type, recorded_transaction_id, visibility, security_revision, current_facts, current_release, projection_pending)
           SELECT $1, subject_id, 'schema:Book', transaction_id, 'visible', 0, 1, $3, false FROM rows
           RETURNING route, subject_id, recorded_transaction_id
         ), revisions AS (
           INSERT INTO semantic.revision (route, subject_id, revision, kind, release, recorded_transaction_id)
           SELECT route, subject_id, 1, 'create', $3, recorded_transaction_id FROM subjects
           RETURNING route, subject_id, recorded_transaction_id
         )
         INSERT INTO semantic.fact
           (route, subject_id, slot_id, log_seq, operation, kind, language, property, statement_id, body, recorded_transaction_id, release, relation)
         SELECT revisions.route, revisions.subject_id, rows.slot_id, 1, 'assert', 'label', 'en', NULL, NULL,
                to_jsonb('Unrelated'::text), revisions.recorded_transaction_id, NULL, false
         FROM revisions JOIN rows USING (subject_id)`,
        [routeValue, JSON.stringify(unrelatedRows), bundledDigest],
      );
      unrelated = scale;
    }

    const count = scale - obsolete;
    const history = Array.from({ length: count }, (_, index) => ({
      revision: obsolete + index + 2,
      transaction_id: newId(routeValue),
      candidate_id: newId(routeValue),
      target_id: newId(routeValue),
    }));
    if (history.length) {
      const encoded = JSON.stringify(history);
      await db.admin.query(
        `WITH history AS MATERIALIZED (
           SELECT * FROM jsonb_to_recordset($1::jsonb)
             AS row(revision integer, transaction_id uuid, candidate_id uuid, target_id uuid)
         )
         INSERT INTO semantic.revision (route, subject_id, revision, kind, release, recorded_transaction_id)
         SELECT $2, $3, revision, 'propose', $4, transaction_id FROM history`,
        [encoded, routeValue, owner, bundledDigest],
      );
      await db.admin.query(
        `WITH history AS MATERIALIZED (
           SELECT * FROM jsonb_to_recordset($1::jsonb)
             AS row(revision integer, transaction_id uuid, candidate_id uuid, target_id uuid)
         )
         INSERT INTO semantic.candidate
           (route, subject_id, candidate_id, slot_id, property, rank, statement, release, revision, origin, view_order, relation)
         SELECT $2, $3, candidate_id, $4, $5, 'normal',
                jsonb_build_object(
                  'property', jsonb_build_object('id', $5),
                  'value', jsonb_build_object('type', 'value', 'content', target_id),
                  'qualifiers', '[]'::jsonb, 'references', '[]'::jsonb
                ), $6, revision, 'proposal', 0, true
         FROM history`,
        [encoded, routeValue, owner, current.slot_id, property, bundledDigest],
      );
      obsolete = scale;
    }
    await db.admin.query('ANALYZE semantic.subject');
    await db.admin.query('ANALYZE semantic.fact');
    await db.admin.query('ANALYZE semantic.revision');

    const measure = async (slot?: string): Promise<readonly [number, number]> => {
      const measured = await capture(db, () =>
        withReadTransaction(db.pool, (client) =>
          currentRelationFacts(client, routeKey, [
            {
              subject: owner,
              property,
              candidate: current.statement_id!,
              target,
              value: 'value',
              context: GLOBAL_CONTEXT,
              ...(slot === undefined ? {} : { slot }),
              requireRelation: true,
            },
          ]),
        ),
      );
      expect(measured.value.get(key)?.statement_id).toBe(current.statement_id);
      assertBound(measured.capture, scale);
      return [
        measured.capture.plans.flatMap(nodes).filter((node) => node['Relation Name'] === 'subject').reduce((n, node) => n + examined(node), 0),
        measured.capture.plans.flatMap(nodes).filter((node) => node['Relation Name'] === 'fact').reduce((n, node) => n + examined(node), 0),
      ];
    };
    measures.push(await measure(current.slot_id!));
    measures.push(await measure());
  }
  expect(measures).toHaveLength(6);
  expect(measures.every((sample) => sample[0] === 1 && sample[1] <= 8)).toBe(true);
});
