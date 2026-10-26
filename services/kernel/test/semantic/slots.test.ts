import { afterAll, beforeAll, expect, test } from 'bun:test';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { createPool } from '../../src/database/pool.ts';
import { newId } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT, StaleEditorialHeadError } from '../../src/semantic/definitions.ts';
import { itemFacts } from '../../src/semantic/item.ts';
import {
  expandSlot,
  insertAcceptance,
  insertAdoption,
  resolveSlot,
  slotId,
  slotView,
} from '../../src/semantic/slots.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(url);
beforeAll(() => bootstrapRelease(pool, bundledRelease));
afterAll(() => pool.end());

test('expansion preserves multiple compact revisions, view order, provenance and virtual heads', async () => {
  const client = await pool.connect();
  await client.query('BEGIN');
  try {
    const route = 471;
    const subject = newId(route);
    const property = 'schema:author';
    const firstTransaction = newId(route);
    const secondTransaction = newId(route);
    const expansionTransaction = newId(route);
    await client.query(
      "INSERT INTO semantic.subject (route, subject_id, type, recorded_transaction_id) VALUES ($1, $2, 'schema:Book', $3)",
      [route, subject, firstTransaction],
    );
    for (const [index, tx] of [firstTransaction, secondTransaction, expansionTransaction].entries()) {
      await client.query(
        `INSERT INTO semantic.revision (route, subject_id, revision, kind, release, recorded_transaction_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [route, subject, index + 1, index ? 'propose' : 'create', bundledDigest, tx],
      );
    }
    const statements = itemFacts(subject, {
      type: 'schema:Book',
      labels: { en: 'Compact history' },
      statements: {
        [property]: ['preferred', 'normal'].map((rank) => ({
          property: { id: property },
          rank,
          value: { type: 'value', content: newId(route) },
        })),
      },
    }).filter((fact) => fact.kind === 'statement');
    for (const [index, row] of statements.entries()) {
      await client.query(
        `INSERT INTO semantic.fact
         (route, subject_id, slot_id, log_seq, operation, kind, release, property, statement_id, body, recorded_transaction_id)
         VALUES ($1, $2, $3, $4, 'assert', 'statement', $5, $6, $7, $8, $9)`,
        [
          route,
          subject,
          row.slot_id,
          row.log_seq,
          bundledDigest,
          property,
          row.statement_id,
          JSON.stringify(row.body),
          index ? secondTransaction : firstTransaction,
        ],
      );
    }
    const before = await resolveSlot(client, subject, property);
    const view = await slotView(client, subject, property);
    expect(before.adoption).toMatchObject({ mode: 'replace', head: 2, revision: 2 });
    await expandSlot(client, subject, property, expansionTransaction);
    await expandSlot(client, subject, property, expansionTransaction);
    const after = await resolveSlot(client, subject, property);
    expect(after.expanded).toBe(true);
    expect(after.adoption).toEqual(before.adoption);
    expect(await slotView(client, subject, property)).toEqual(view);
    const candidates = await client.query(
      'SELECT release, revision, origin FROM semantic.candidate WHERE route = $1 AND subject_id = $2 ORDER BY revision',
      [route, subject],
    );
    expect(candidates.rows).toEqual(
      [1, 2].map((revision) => ({ release: bundledDigest, revision, origin: 'compact' })),
    );
    const expansions = await client.query(
      "SELECT log_seq FROM semantic.fact WHERE route = $1 AND subject_id = $2 AND operation = 'expand'",
      [route, subject],
    );
    expect(expansions.rows).toEqual([{ log_seq: 33 }]);

    const candidate = statements[0]!.statement_id!;
    const slot = slotId(subject, property);
    await expect(
      insertAcceptance(client, subject, candidate, GLOBAL_CONTEXT, null, 'reject', 3, slot),
    ).rejects.toBeInstanceOf(StaleEditorialHeadError);
    expect(await insertAcceptance(client, subject, candidate, GLOBAL_CONTEXT, 1, 'abstain', 3, slot)).toBe(2);
    await expect(
      insertAdoption(client, subject, property, GLOBAL_CONTEXT, 1, 'suppress', [], 3),
    ).rejects.toBeInstanceOf(StaleEditorialHeadError);
    expect(await insertAdoption(client, subject, property, GLOBAL_CONTEXT, 2, 'suppress', [], 3)).toBe(3);

    for (const table of ['fact', 'candidate', 'acceptance', 'adoption', 'revision']) {
      for (const sql of [
        `UPDATE semantic.${table} SET route = route WHERE subject_id = $1`,
        `DELETE FROM semantic.${table} WHERE subject_id = $1`,
      ]) {
        await client.query('SAVEPOINT immutable');
        await expect(client.query(sql, [subject])).rejects.toMatchObject({ code: '23514' });
        await client.query('ROLLBACK TO SAVEPOINT immutable');
      }
      await client.query('SAVEPOINT immutable');
      await expect(client.query(`TRUNCATE semantic.${table} CASCADE`)).rejects.toMatchObject({ code: '23514' });
      await client.query('ROLLBACK TO SAVEPOINT immutable');
    }
    await client.query('SAVEPOINT wrong_route');
    await expect(
      client.query(
        `INSERT INTO semantic.candidate
       (route, subject_id, candidate_id, slot_id, property, rank, statement, release, revision, origin)
       VALUES ($1, $2, $3, $4, $5, 'normal', '{}', $6, 3, 'proposal')`,
        [route + 1, subject, newId(route + 1), statements[0]!.slot_id, property, bundledDigest],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await client.query('ROLLBACK TO SAVEPOINT wrong_route');
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});
