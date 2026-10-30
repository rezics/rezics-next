import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { fromPlainText } from '@rezics/document';
import { noEffect, runCommand } from '../../src/command/command.ts';
import { readAuthoredField } from '../../src/content/authored-fields.ts';
import { purgeAuthoredFieldForDeletedRecord } from '../../src/content/authored-field-retention.ts';
import lock from '../../src/content/authored-field-retention-lock.sql';
import purge from '../../src/content/authored-field-retention-purge.sql';
import bind from '../../src/content/authored-field-retention-bind.sql';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { prepareRecordPurgeAuthority } from '../../src/semantic/record-purge-authority.ts';
import { createDeletionFixture } from '../semantic/support/deletion-fixture.ts';

setDefaultTimeout(120_000);
const fixture = await createDeletionFixture();
beforeAll(fixture.setup);
afterAll(fixture.close);

async function authored() {
  const created = await fixture.call('POST', '/v1/subjects', 'owner', {
    type: 'schema:Recipe',
    labels: { en: 'Authored custody control' },
    statements: {
      'schema:abstract': [
        {
          property: { id: 'schema:abstract' },
          value: {
            type: 'value',
            content: {
              document: fromPlainText('Retained until physical purge.'),
              licence: 'CC-BY-4.0',
              language: 'en',
            },
          },
          references: [{ parts: [fixture.snak('schema:url', 'https://example.test/recipe')] }],
        },
      ],
    },
  });
  fixture.status(created, 201);
  const subject = created.body.subject;
  const candidate = subject.statements['schema:abstract'][0];
  const documentId: string = candidate.value.content.document;
  const route = routeOf(documentId)!;
  const stored = await readAuthoredField(fixture.admin, route, documentId);
  expect(stored).not.toBeNull();
  if (!stored) throw new Error('Native authored field was not stored');
  return { route, stored };
}

// These are Content SQL custody controls, using native authored-document creation.
// Their sample binding is never passed off as an opaque Semantic authority. Native
// hold/restore/deadline acceptance still requires the real source issuer and lock.
function binding(field: Awaited<ReturnType<typeof authored>>) {
  const deletionT = fixture.clock();
  return {
    route: field.route,
    document_id: field.stored.id,
    subject_id: field.stored.subject,
    candidate_id: field.stored.candidate,
    revision: field.stored.revision,
    deletion_generation: randomUUID(),
    source_version: '1',
    deletion_transaction_id: randomUUID(),
    deletion_committed_at: deletionT.toISOString(),
    purge_after: new Date(deletionT.getTime() + 30 * 86_400_000).toISOString(),
  };
}

test('exact authored tuple stores physical NULL and an exact idempotent generation binding', async () => {
  const field = await authored();
  const input = binding(field);
  const tx = await fixture.pool.connect();
  try {
    await tx.query('BEGIN');
    expect(await lock.run(tx, input)).toMatchObject({ recorded: false, body_is_null: false });
    expect(await purge.run(tx, input)).toEqual({ id: field.stored.id });
    expect(await bind.run(tx, input)).toEqual([{ document_id: field.stored.id }]);
    expect(await lock.run(tx, input)).toMatchObject({
      recorded: true,
      same_source: true,
      body_is_null: true,
      availability: 'erased',
    });
    expect(await purge.run(tx, input)).toBeNull();
    await tx.query('COMMIT');
  } finally {
    await tx.query('ROLLBACK');
    tx.release();
  }
  expect(await readAuthoredField(fixture.admin, field.route, field.stored.id)).toEqual({
    ...field.stored,
    body: null,
    availability: 'erased',
  });
});

test('Content SQL refuses another authored tuple and exposes a stored generation mismatch', async () => {
  const field = await authored();
  const input = binding(field);
  const tx = await fixture.pool.connect();
  try {
    await tx.query('BEGIN');
    for (const mismatch of [
      { document_id: newId(field.route) },
      { subject_id: newId(field.route) },
      { candidate_id: newId(field.route) },
      { revision: field.stored.revision + 1 },
    ]) {
      expect(await lock.run(tx, { ...input, ...mismatch })).toBeNull();
      expect(await purge.run(tx, { ...input, ...mismatch })).toBeNull();
      expect(await bind.run(tx, { ...input, ...mismatch })).toEqual([]);
    }
    expect((await readAuthoredField(tx, field.route, field.stored.id))?.body).toEqual(field.stored.body);
    await purge.run(tx, input);
    await bind.run(tx, input);
    expect(await lock.run(tx, { ...input, deletion_generation: randomUUID() })).toMatchObject({
      recorded: true,
      same_source: false,
      body_is_null: true,
    });
  } finally {
    await tx.query('ROLLBACK');
    tx.release();
  }
});

test('rollback preserves physical authored bytes and removes the tentative source binding', async () => {
  const field = await authored();
  const input = binding(field);
  const tx = await fixture.pool.connect();
  try {
    await tx.query('BEGIN');
    await lock.run(tx, input);
    await purge.run(tx, input);
    await bind.run(tx, input);
    expect((await lock.run(tx, input))?.recorded).toBe(true);
    await tx.query('ROLLBACK');
    expect(await readAuthoredField(tx, field.route, field.stored.id)).toEqual(field.stored);
    expect(await lock.run(tx, input)).toMatchObject({ recorded: false, body_is_null: false });
  } finally {
    await tx.query('ROLLBACK');
    tx.release();
  }
});

test('native issuance refuses an active record and a structural payload cannot acknowledge custody', async () => {
  const field = await authored();
  const payload = binding(field);
  // This assertion deliberately requires the real issuer to answer. Unavailable
  // is a failure of native acceptance, never a successful ineligibility result.
  expect(
    await prepareRecordPurgeAuthority(
      { pool: fixture.pool, clock: fixture.clock },
      {
        subjectId: field.stored.subject,
        candidateId: field.stored.candidate,
        revision: field.stored.revision,
        documentId: field.stored.id,
        deletionGeneration: payload.deletion_generation,
      },
      { deadline: Date.now() + 10_000 },
    ),
  ).toBeNull();
  // Deliberately cross the untyped input boundary; this is a rejection control,
  // never a fabricated authority used to exercise a successful purge.
  await expect(
    runCommand(
      fixture.pool,
      {
        partition: partitionOf(field.route),
        deadline: Date.now() + 10_000,
        clock: fixture.clock,
      },
      async (tx) => noEffect(await Reflect.apply(purgeAuthoredFieldForDeletedRecord, undefined, [tx, payload])),
    ),
  ).rejects.toThrow();
  expect(await readAuthoredField(fixture.admin, field.route, field.stored.id)).toEqual(field.stored);
  expect(await lock.run(fixture.admin, payload)).toMatchObject({ recorded: false, body_is_null: false });
});
