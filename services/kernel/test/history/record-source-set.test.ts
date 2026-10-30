import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { noEffect, principalCommandIdentity, runCommand } from '../../src/command/command.ts';
import { declareCommandHistory } from '../../src/history/record.ts';
import {
  beginRecordHistorySerialization,
  declareCommandRecordSources,
  declareCommandRecordSourceSet,
  type RecordHistorySourceReference,
} from '../../src/history/record-source.ts';
import {
  type SemanticRecordSourceSet,
  validateRecordSourceSetCommitment,
} from '../../src/history/record-source-set.ts';
import { RecordSourceSetUnavailableError } from '../../src/history/record-source-set-native.ts';
import { routeOf, partitionOf } from '../../src/route/route.ts';
import { createDeletionFixture } from '../semantic/support/deletion-fixture.ts';
import { custodyFixture, digest, kind, scope, type CustodyFixture, type Person } from './command-custody-fixture.ts';

let f: CustodyFixture;
let native: Awaited<ReturnType<typeof createDeletionFixture>>;
let person: Person;
let source: RecordHistorySourceReference;
let partition: number;
beforeAll(async () => {
  f = await custodyFixture();
  native = await createDeletionFixture(f.db);
  await native.setup();
  person = await f.auth.person(`source_set_${randomUUID().replaceAll('-', '')}`);
  const record = await native.proposal(await native.person());
  const row = (
    await f.db.admin.query(
      'SELECT revision FROM semantic.candidate WHERE route=$1 AND subject_id=$2 AND candidate_id=$3',
      [routeOf(record.subject), record.subject, record.candidate],
    )
  ).rows[0];
  source = {
    kind: 'contribution',
    subjectId: record.subject,
    candidateId: record.candidate,
    revision: row.revision,
    documentId: null,
  };
  partition = partitionOf(routeOf(record.subject)!);
}, 180_000);
afterAll(async () => {
  await native?.close();
  await f?.close();
});

async function command(body: Parameters<typeof runCommand>[2]) {
  const ctx = await f.context(person, partition);
  return runCommand(
    f.db.pool,
    {
      ...principalCommandIdentity(ctx.actor),
      partition,
      deadline: ctx.deadline,
      authorization: ctx.authorization,
      receipt: { kind, key: randomUUID(), digest },
    },
    body,
  );
}

// Deliberately forged ONLY for refusal cases. This is never a native set/issuer fixture.
const forged = () => Object.freeze({}) as SemanticRecordSourceSet;

test('small declarations retain sixteen/once and cannot be combined with a native set declaration', async () => {
  await command(async (tx) => {
    expect(() =>
      declareCommandRecordSources(
        tx,
        Array.from({ length: 512 }, () => source),
      ),
    ).toThrow();
    declareCommandRecordSources(tx, [source]);
    expect(() => declareCommandRecordSources(tx, [source])).toThrow();
    expect(() => declareCommandRecordSourceSet(tx, forged())).toThrow();
    await declareCommandHistory(tx, kind, scope(person));
    return noEffect({ source: 'actual native contribution' });
  });
});

test('a native-set declaration excludes repeated sets and small declarations; a fabricated handle cannot serialize', async () => {
  const before = (await f.db.admin.query('SELECT count(*)::integer AS n FROM core.record_history_source_set')).rows[0]
    .n;
  await expect(
    command(async (tx) => {
      declareCommandRecordSourceSet(tx, forged());
      expect(() => declareCommandRecordSourceSet(tx, forged())).toThrow();
      expect(() => declareCommandRecordSources(tx, [source])).toThrow();
      await declareCommandHistory(tx, kind, scope(person));
      return noEffect({ payload: 'must roll back rather than claim native membership' });
    }),
  ).rejects.toBeInstanceOf(RecordSourceSetUnavailableError);
  expect((await f.db.admin.query('SELECT count(*)::integer AS n FROM core.record_history_source_set')).rows[0].n).toBe(
    before,
  );
});

test('both declaration forms close before serialization, including commands without events', async () => {
  await command(async (tx) => {
    beginRecordHistorySerialization(tx);
    expect(() => declareCommandRecordSourceSet(tx, forged())).toThrow();
    expect(() => declareCommandRecordSources(tx, [source])).toThrow();
    await declareCommandHistory(tx, kind, scope(person));
    return noEffect(null);
  });
});

test('the compact transport boundary retains 512 and opaque term-capable membership without accepting a member vector', () => {
  // Shape validation is not issuance or evidence of 512 native facts. That positive case
  // requires the absent Semantic immutable issuer/reverse index, not a fake candidate/set.
  const commitment = {
    sourcePartition: partition,
    locator: new Uint8Array([1]),
    revision: new Uint8Array([2]),
    originalTransaction: randomUUID(),
    memberCount: 512,
  };
  expect(() => validateRecordSourceSetCommitment(commitment)).not.toThrow();
  expect(() => validateRecordSourceSetCommitment({ ...commitment, memberCount: 513 })).toThrow();
  expect(() => validateRecordSourceSetCommitment({ ...commitment, memberCount: 0 })).toThrow();
  const vector = { ...commitment, members: [source] };
  expect(() => validateRecordSourceSetCommitment(vector)).toThrow();
});
