import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledRelease } from '@rezics/definitions/bundled';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { routeOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT, StaleEditorialHeadError } from '../../src/semantic/definitions.ts';
import { insertAcceptance, insertAdoption, slotId } from '../../src/semantic/slots.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(url);
beforeAll(() => bootstrapRelease(pool, bundledRelease));
afterAll(() => pool.end());
const kernel = createKernel({
  pool,
  routeKey: new Uint8Array(32).fill(7),
  access: {
    async authenticate() {
      return {
        kind: 'account',
        accountId: '019a1b2c-3d4e-7f00-8a00-ed170e000001',
        clientId: 'web',
        scopes: ['subject:create', 'statement:propose', 'subject:read'],
        requestedBy: null,
        authnEpoch: 1,
      };
    },
    async authorize() {
      return true;
    },
  },
  writeRate: {
    async spend() {
      return { allowed: true };
    },
  },
});
const property = 'schema:inLanguage';
const statement = {
  property: { id: property },
  value: { type: 'value', content: 'ja' },
  references: [
    { parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.com/source' } }] },
  ],
};

async function call(path: string, body?: unknown) {
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: 'Bearer editor',
        'content-type': 'application/json',
        'idempotency-key': `"${randomUUID()}"`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  expect(response.status).toBe(body === undefined ? 200 : 201);
  return response.json();
}

test('candidate and revision listings default to twenty rows and resume without gaps', async () => {
  const { subject } = await call('/v1/subjects', { type: 'schema:Book', labels: { en: 'Page boundaries' } });
  for (let i = 0; i < 21; i++) await call(`/v1/subjects/${subject.id}/candidates`, { statement });
  const candidatesPath = `/v1/subjects/${subject.id}/candidates?property=${property}`;
  const candidates = await call(candidatesPath);
  expect(candidates.candidates.map((row: { revision: number }) => row.revision)).toEqual(
    Array.from({ length: 20 }, (_, i) => i + 2),
  );
  expect(candidates.next).toEqual(expect.any(String));
  const tail = await call(`${candidatesPath}&cursor=${encodeURIComponent(candidates.next)}`);
  expect(tail.candidates.map((row: { revision: number }) => row.revision)).toEqual([22]);
  expect(tail.next).toBeNull();

  const revisionsPath = `/v1/subjects/${subject.id}/revisions`;
  const revisions = await call(revisionsPath);
  expect(revisions.revisions.map((row: { revision: number }) => row.revision)).toEqual(
    Array.from({ length: 20 }, (_, i) => 22 - i),
  );
  expect(revisions.next).toEqual(expect.any(String));
  const older = await call(`${revisionsPath}?cursor=${encodeURIComponent(revisions.next)}`);
  expect(older.revisions.map((row: { revision: number }) => row.revision)).toEqual([2, 1]);
  expect(older.next).toBeNull();
});

test('editorial insert-CAS refuses nonexistent expected heads and selections contain objects', async () => {
  const { subject } = await call('/v1/subjects', { type: 'schema:Book', labels: { en: 'Editorial heads' } });
  const { candidate, revision } = await call(`/v1/subjects/${subject.id}/candidates`, { statement });
  const slot = slotId(subject.id, property);
  const tx = await pool.connect();
  await tx.query('BEGIN');
  try {
    await expect(
      insertAcceptance(tx, subject.id, candidate, GLOBAL_CONTEXT, 5, 'accept', revision, slot),
    ).rejects.toBeInstanceOf(StaleEditorialHeadError);
    expect(await insertAcceptance(tx, subject.id, candidate, GLOBAL_CONTEXT, null, 'accept', revision, slot)).toBe(1);
    for (const expected of [5, null]) {
      await expect(
        insertAcceptance(tx, subject.id, candidate, GLOBAL_CONTEXT, expected, 'accept', revision, slot),
      ).rejects.toBeInstanceOf(StaleEditorialHeadError);
    }
    expect(await insertAcceptance(tx, subject.id, candidate, GLOBAL_CONTEXT, 1, 'abstain', revision, slot)).toBe(2);
    await expect(
      insertAdoption(tx, subject.id, property, GLOBAL_CONTEXT, 5, 'suppress', [], revision),
    ).rejects.toBeInstanceOf(StaleEditorialHeadError);
    expect(await insertAdoption(tx, subject.id, property, GLOBAL_CONTEXT, null, 'suppress', [], revision)).toBe(1);
    await expect(
      insertAdoption(tx, subject.id, property, GLOBAL_CONTEXT, 5, 'suppress', [], revision),
    ).rejects.toBeInstanceOf(StaleEditorialHeadError);
    expect(await insertAdoption(tx, subject.id, property, GLOBAL_CONTEXT, 1, 'suppress', [], revision)).toBe(2);

    for (const entry of [null, 1, 'candidate', [], [{ candidate, rank: 'normal' }]]) {
      await tx.query('SAVEPOINT selection');
      await expect(
        tx.query(
          `INSERT INTO semantic.adoption (route, subject_id, slot_id, context_id, head, mode, selection, revision)
           VALUES ($1, $2, $3, $4, 3, 'replace', $5, $6)`,
          [
            routeOf(subject.id),
            subject.id,
            slotId(subject.id, property),
            GLOBAL_CONTEXT,
            JSON.stringify([entry]),
            revision,
          ],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await tx.query('ROLLBACK TO SAVEPOINT selection');
    }
  } finally {
    await tx.query('ROLLBACK');
    tx.release();
  }
});
