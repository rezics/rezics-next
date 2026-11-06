import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledRelease } from '@rezics/definitions/bundled';
import { fromPlainText } from '@rezics/document';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { principalCommandIdentity, runCommand, type CommandTransaction } from '../../src/command/command.ts';
import { declareCommandHistory } from '../../src/history/adapters/record.ts';
import { declareCommandRecordSources } from '../../src/history/adapters/record-source.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import {
  appendSemanticRecordSourceSet,
  beginSemanticRecordSourceSet,
  pageSemanticRecordSourceSets,
  readSemanticRecordSourceSet,
  sealSemanticRecordSourceSet,
  semanticRecordSourceSetLocator,
  verifySemanticRecordSourceSet,
  type SemanticRecordSourceSetLocator,
} from '../../src/semantic/record-source-set.ts';
import {
  custodyFixture,
  digest,
  kind,
  scope,
  type CustodyFixture,
  type Person,
} from '../history/command-custody-fixture.ts';
import { createDeletionFixture } from './support/deletion-fixture.ts';
import { type RecordHistorySourceReference } from '../../src/history/contract/record-vocabulary.ts';

let f: CustodyFixture;
let native: Awaited<ReturnType<typeof createDeletionFixture>>;
let person: Person;
beforeAll(async () => {
  f = await custodyFixture();
  native = await createDeletionFixture(f.db);
  await native.setup();
  person = await f.auth.person(`source_${randomUUID().replaceAll('-', '')}`);
}, 180_000);
afterAll(async () => {
  await native?.close();
  await f?.close();
});
const deadline = () => Date.now() + 30_000;

async function sourceSet(subject: string, revision: number) {
  const rows = (
    await f.db.admin.query(
      `SELECT s.transaction_id::text,s.revision,s.digest,s.members,s.sealed
     FROM semantic.revision r JOIN semantic.record_source_set s
       ON s.partition_no=r.route/16 AND s.transaction_id=r.recorded_transaction_id
     WHERE r.route=$1 AND r.subject_id=$2 AND r.revision=$3`,
      [routeOf(subject), subject, revision],
    )
  ).rows;
  expect(rows).toHaveLength(1);
  expect(rows[0].sealed).toBe(true);
  const locator: SemanticRecordSourceSetLocator = {
    partition: partitionOf(routeOf(subject)!),
    transactionId: rows[0].transaction_id,
    revision: rows[0].revision,
  };
  const snapshot = await readSemanticRecordSourceSet({ pool: f.db.pool }, locator, { deadline: deadline() });
  expect(snapshot).toEqual({ locator, digest: rows[0].digest, members: rows[0].members });
  const members = (
    await f.db.admin.query(
      `SELECT kind,subject_id::text,candidate_id::text,source_revision,document_id::text,field,language
     FROM semantic.record_source_set_member WHERE partition_no=$1 AND transaction_id=$2 ORDER BY source_key`,
      [locator.partition, locator.transactionId],
    )
  ).rows;
  return { snapshot: snapshot!, members };
}

// Uses the existing native executor/authorization/serializer fixture, without replacing any producer.
async function command(partition: number, body: (tx: CommandTransaction) => Promise<void>) {
  const ctx = await f.context(person, partition);
  const scopes = scope(person);
  return runCommand(
    f.db.pool,
    {
      ...principalCommandIdentity(ctx.actor),
      partition,
      deadline: ctx.deadline,
      authorization: ctx.authorization,
      receipt: { kind, key: randomUUID(), digest },
    },
    async (tx) => {
      await body(tx);
      await declareCommandHistory(tx, kind, {
        ...scopes,
        events: [{ artifactType: 'outbox-event/v1', accounts: scopes.response.accounts }],
      });
      return {
        value: { version: 0 },
        events: [
          { type: 'com.rezics.library.entry.purged.v1', subject: person.accountId, data: { deletionId: randomUUID() } },
        ],
      };
    },
  );
}

test('One native bounded source set enrolls every actual old current contribution and term source of a command before serialization without fake candidates or truncating compact512', async () => {
  // The same legal compact512 shape as the existing contribution lifecycle acceptance.
  const languages = ['en', 'fr', 'de', 'es', 'it', 'ja', 'ko', 'zh', 'pt', 'ru', 'ar', 'nl', 'sv', 'pl', 'fi', 'da'];
  const aliases = Object.fromEntries(
    languages.map((language, index) => [
      language,
      Array.from({ length: index === 15 ? 30 : 32 }, (_, n) => `Alias ${language} ${n}`),
    ]),
  );
  const key = `"${randomUUID()}"`;
  const input = {
    type: 'schema:Person',
    labels: { en: 'All compact sources' },
    aliases,
    statements: { 'schema:url': [native.cited('schema:url', 'https://example.test/original')] },
  };
  const made = await native.call('POST', '/v1/subjects', 'owner', input, key);
  native.status(made, 201);
  const subject = made.body.subject.id as string;
  const candidate = made.body.subject.statements['schema:url'][0].id as string;
  expect(
    (
      await f.db.admin.query('SELECT count(*)::int n FROM semantic.fact WHERE route=$1 AND subject_id=$2', [
        routeOf(subject),
        subject,
      ])
    ).rows[0].n,
  ).toBe(512);
  expect(
    (
      await f.db.admin.query('SELECT count(*)::int n FROM semantic.candidate WHERE route=$1 AND subject_id=$2', [
        routeOf(subject),
        subject,
      ])
    ).rows[0].n,
  ).toBe(0);
  const created = await sourceSet(subject, 1);
  // 510 alias values are sixteen real language source units. They are never fake contributions.
  expect(created.snapshot.members).toBe(18);
  expect(created.members).toHaveLength(18);
  expect(
    created.members
      .filter((m) => m.kind === 'terms' && m.field === 'aliases')
      .map((m) => m.language)
      .sort(),
  ).toEqual([...languages].sort());
  expect(created.members.filter((m) => m.kind === 'contribution')).toEqual([
    expect.objectContaining({ candidate_id: candidate, source_revision: 1, document_id: null }),
  ]);
  // A second compact512 shape reaches the actual source-member ceiling, without padding it.
  const labels = Object.fromEntries(Array.from({ length: 511 }, (_, i) => [i ? `en-x-${i}` : 'en', `Name ${i}`]));
  const ceiling = await native.call('POST', '/v1/subjects', 'owner', {
    type: 'schema:Person',
    labels,
    statements: { 'schema:url': [native.cited('schema:url', 'https://example.test/ceiling')] },
  });
  native.status(ceiling, 201);
  const full = await sourceSet(ceiling.body.subject.id, 1);
  expect(full.snapshot.members).toBe(512);
  expect(full.members).toHaveLength(512);
  expect(full.members.filter((m) => m.kind === 'contribution')).toHaveLength(1);
  const replay = await native.call('POST', '/v1/subjects', 'owner', input, key);
  expect(replay).toEqual(made);
  expect((await sourceSet(subject, 1)).snapshot).toEqual(created.snapshot);

  const proposed = await native.proposal(subject);
  const proposedRevision = Number(
    (
      await f.db.admin.query(
        'SELECT revision FROM semantic.candidate WHERE route=$1 AND subject_id=$2 AND candidate_id=$3',
        [routeOf(subject), subject, proposed.candidate],
      )
    ).rows[0].revision,
  );
  const proposal = await sourceSet(subject, proposedRevision);
  expect(proposal.members).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: 'contribution', candidate_id: candidate, source_revision: 1 }),
      expect.objectContaining({
        kind: 'contribution',
        candidate_id: proposed.candidate,
        source_revision: proposedRevision,
      }),
    ]),
  );
  await native.accept(proposed);
  await native.adopt(proposed, 1);
  const revision = (await native.revisions(subject)).at(-1)!.revision;
  const adopted = await sourceSet(subject, revision);
  expect(adopted.members).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: 'contribution', candidate_id: candidate, source_revision: 1 }),
      expect.objectContaining({
        kind: 'contribution',
        candidate_id: proposed.candidate,
        source_revision: proposedRevision,
      }),
    ]),
  );
  const reference: RecordHistorySourceReference = {
    kind: 'contribution',
    subjectId: subject,
    candidateId: candidate,
    revision: 1,
    documentId: null,
  };
  const page = await pageSemanticRecordSourceSets({ pool: f.db.pool }, reference, {
    frontier: null,
    limit: 100,
    deadline: deadline(),
  });
  expect(page.state).toBe('complete');
  expect(page.sets).toEqual(expect.arrayContaining([created.snapshot, proposal.snapshot, adopted.snapshot]));
  expect(page.examined).toBeLessThanOrEqual(100);
}, 180_000);

test('terms have native indexed keys without invented candidates and bounded lookup frontiers', async () => {
  const language = `en-x-${Array.from({ length: 20 }, () => 'abcdefgh').join('-')}`;
  const made = await native.call('POST', '/v1/subjects', 'owner', {
    type: 'schema:Person',
    labels: { en: 'Terms only' },
    descriptions: { en: 'Native description' },
    aliases: { [language]: ['One', 'Two'] },
  });
  native.status(made, 201);
  const subject = made.body.subject.id as string;
  const { snapshot, members } = await sourceSet(subject, 1);
  expect(snapshot.members).toBe(3);
  expect(members.map((m) => m.field).sort()).toEqual(['aliases', 'descriptions', 'labels']);
  expect(members.every((m) => m.kind === 'terms' && m.candidate_id === null)).toBe(true);
  const reference = { kind: 'terms' as const, subjectId: subject, revision: 1, field: 'aliases' as const, language };
  const first = await pageSemanticRecordSourceSets({ pool: f.db.pool }, reference, {
    frontier: null,
    limit: 1,
    deadline: deadline(),
  });
  expect(first).toMatchObject({ state: 'progress', sets: [snapshot], examined: 1 });
  expect(
    await pageSemanticRecordSourceSets({ pool: f.db.pool }, reference, {
      frontier: first.frontier,
      limit: 1,
      deadline: deadline(),
    }),
  ).toEqual({ state: 'complete', sets: [], frontier: null, examined: 0 });
});

test('the original native command owns one immutable sealed set and rollback exposes none', async () => {
  const subject = await native.person('Native command ownership');
  const partition = partitionOf(routeOf(subject)!);
  let locator!: SemanticRecordSourceSetLocator;
  await expect(
    command(partition, async (tx) => {
      const set = await beginSemanticRecordSourceSet(tx);
      locator = semanticRecordSourceSetLocator(tx, set);
      await appendSemanticRecordSourceSet(tx, set, {
        sources: [],
        terms: [{ subjectId: subject, originalRevision: null, currentRevision: 1, field: 'labels', language: 'en' }],
      });
      // Only native commit/seal may make this row externally visible.
      expect(await readSemanticRecordSourceSet({ pool: f.db.pool }, locator, { deadline: deadline() })).toBeNull();
    }),
  ).rejects.toThrow('Unsealed or mismatched');
  expect(await readSemanticRecordSourceSet({ pool: f.db.pool }, locator, { deadline: deadline() })).toBeNull();

  await expect(
    command(partition, async (tx) => {
      await beginSemanticRecordSourceSet(tx);
      await beginSemanticRecordSourceSet(tx);
    }),
  ).rejects.toThrow('Repeated Semantic');
  await expect(
    command(partition, async (tx) => {
      const set = await beginSemanticRecordSourceSet(tx);
      await sealSemanticRecordSourceSet(tx, set);
      declareCommandRecordSources(tx, [{ kind: 'context', contextId: GLOBAL_CONTEXT }]);
    }),
  ).rejects.toThrow();

  await command(partition, async (tx) => {
    const set = await beginSemanticRecordSourceSet(tx);
    locator = semanticRecordSourceSetLocator(tx, set);
    await appendSemanticRecordSourceSet(tx, set, {
      sources: [],
      terms: [{ subjectId: subject, originalRevision: 1, currentRevision: 1, field: 'labels', language: 'en' }],
    });
    expect(await verifySemanticRecordSourceSet(tx, locator, '0'.repeat(64))).toBe(false);
    await sealSemanticRecordSourceSet(tx, set);
    const row = (
      await tx.query('SELECT digest FROM semantic.record_source_set WHERE partition_no=$1 AND transaction_id=$2', [
        locator.partition,
        locator.transactionId,
      ])
    ).rows[0];
    expect(await verifySemanticRecordSourceSet(tx, locator, row.digest)).toBe(true);
    await expect(appendSemanticRecordSourceSet(tx, set, { sources: [], terms: [] })).rejects.toThrow('sealed');
  });
  expect((await readSemanticRecordSourceSet({ pool: f.db.pool }, locator, { deadline: deadline() }))?.members).toBe(1);
  await expect(
    f.db.admin.query('UPDATE semantic.record_source_set SET members=0 WHERE partition_no=$1 AND transaction_id=$2', [
      locator.partition,
      locator.transactionId,
    ]),
  ).rejects.toThrow('Immutable');
  await expect(
    f.db.admin.query('DELETE FROM semantic.record_source_set_member WHERE partition_no=$1 AND transaction_id=$2', [
      locator.partition,
      locator.transactionId,
    ]),
  ).rejects.toThrow('Immutable');
});

test('Content append-returned document IDs and copied originals belong to the same real contribution unit', async () => {
  const property = bundledRelease.types['schema:Recipe']!.properties.includes('schema:recipeInstructions')
    ? 'schema:recipeInstructions'
    : 'schema:abstract';
  const statement = (text: string) =>
    native.cited(property, {
      document: fromPlainText(text),
      licence: 'CC-BY-4.0',
      language: 'en',
    });
  const made = await native.call('POST', '/v1/subjects', 'owner', {
    type: 'schema:Recipe',
    labels: { en: 'Native recipe' },
    statements: { [property]: [statement('Simmer gently.')] },
  });
  native.status(made, 201);
  const subject = made.body.subject.id as string;
  const original = made.body.subject.statements[property][0];
  const doc = original.value.content.document as string;
  const created = await sourceSet(subject, 1);
  expect(created.members).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ candidate_id: original.id, source_revision: 1, document_id: doc }),
    ]),
  );
  await expect(
    command(created.snapshot.locator.partition, async (tx) => {
      const set = await beginSemanticRecordSourceSet(tx);
      await appendSemanticRecordSourceSet(tx, set, {
        sources: [
          { kind: 'contribution', subjectId: subject, candidateId: original.id, revision: 1, documentId: null },
        ],
        terms: [],
      });
      await sealSemanticRecordSourceSet(tx, set);
    }),
  ).rejects.toThrow('omitted or invented a native document');
  expect(created.snapshot.members).toBe(3); // One contribution, its actual document reference, and one label.
  const proposal = await native.call('POST', `/v1/subjects/${subject}/candidates`, 'owner', {
    statement: statement('Simmer for thirty minutes.'),
  });
  native.status(proposal, 201);
  const copied = await sourceSet(subject, proposal.body.revision);
  expect(copied.members).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ candidate_id: original.id, source_revision: 1, document_id: doc }),
      expect.objectContaining({
        candidate_id: proposal.body.candidate,
        source_revision: proposal.body.revision,
        document_id: expect.any(String),
      }),
    ]),
  );
  const lookup = await pageSemanticRecordSourceSets(
    { pool: f.db.pool },
    { kind: 'contribution', subjectId: subject, candidateId: original.id, revision: 1, documentId: doc },
    { frontier: null, limit: 100, deadline: deadline() },
  );
  expect(lookup.sets).toEqual(expect.arrayContaining([created.snapshot, copied.snapshot]));
});
