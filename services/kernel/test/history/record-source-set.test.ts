import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { noEffect, principalCommandIdentity, runCommand } from '../../src/command/command.ts';
import { declareCommandHistory } from '../../src/history/adapters/record.ts';
import {
  beginRecordHistorySerialization,
  declareCommandRecordSources,
  declareCommandRecordSourceSet,
} from '../../src/history/adapters/record-source.ts';
import {
  type SemanticRecordSourceSet,
  validateRecordSourceSetCommitment,
} from '../../src/history/adapters/record-source-set.ts';
import { nativeRecordSourceSetProducer } from '../../src/history/adapters/record-source-set-native.ts';
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
  ).rejects.toBeInstanceOf(TypeError);
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

// These are the original owner type, not a structurally compatible History brand.
import type { SemanticRecordSourceSet as OwnerSourceSet } from '../../src/semantic/record-source-set.ts';
import { currentCommand } from '../../src/command/command.ts';
import { stageHistoryWork } from '../../src/work/history-enqueue.ts';
import { decodeLocator, encodeLocator } from '../../src/history/contract/locator.ts';
import {
  recordSourceSetStorageKey,
  validateNativeRecordSourceSetSnapshot,
} from '../../src/history/adapters/record-source-set.ts';
import { type RecordHistorySourceReference } from '../../src/history/contract/record-vocabulary.ts';

type SameType<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const originalType: SameType<SemanticRecordSourceSet, OwnerSourceSet> = true;

function actualProducer() {
  return nativeRecordSourceSetProducer();
}

/** beginSemanticRecordSourceSet registers the seal-guard callback, so the command
 * cannot be no-effect. Match Semantic's owner test: one outbox event, declared. */
function sourceSetCommand(value: unknown) {
  const scopes = scope(person);
  return {
    declaration: {
      ...scopes,
      events: [{ artifactType: 'outbox-event/v1' as const, accounts: scopes.response.accounts }],
    },
    result: {
      value,
      events: [
        {
          type: 'com.rezics.library.entry.purged.v1',
          subject: person.accountId,
          data: { deletionId: randomUUID() },
        },
      ],
    },
  };
}

test('History preserves the original opaque type and structured native snapshot without a member vector', () => {
  expect(originalType).toBe(true);
  const snapshot = {
    locator: { partition: 0, transactionId: randomUUID(), revision: 1 },
    digest: 'native-digest',
    members: 512,
  };
  expect(() => validateNativeRecordSourceSetSnapshot(snapshot)).not.toThrow();
  expect(() => validateNativeRecordSourceSetSnapshot({ ...snapshot, members: 513 })).toThrow();
  expect(() => validateNativeRecordSourceSetSnapshot({ ...snapshot, members: [source] } as never)).toThrow();
  expect(recordSourceSetStorageKey(snapshot.locator)[2].toString()).toBe('1');
});

test('History consumes the actual Semantic one-set building seal locator revision and reverse index without provisional issuer fields or premature completeness, source and real copy associations commit atomically', async () => {
  const producer = actualProducer();
  const workId = randomUUID();
  let locator: import('../../src/semantic/record-source-set.ts').SemanticRecordSourceSetLocator | undefined;
  const result = await command(async (tx) => {
    const set = await producer.beginSemanticRecordSourceSet(tx);
    locator = producer.semanticRecordSourceSetLocator(tx, set);
    expect(locator.partition).toBe(currentCommand(tx).partition);
    expect(locator.transactionId).toBe(currentCommand(tx).transactionId);
    expect(() => declareCommandRecordSourceSet(tx, set)).toThrow();
    expect(() => declareCommandRecordSources(tx, [source])).toThrow();
    const outcome = sourceSetCommand({ payload: 'native set' });
    await declareCommandHistory(tx, kind, outcome.declaration);
    await stageHistoryWork(tx, {
      owner: 'record-purge-fixture',
      intent: {
        queue: 'maintenance',
        workflowName: 'record-purge-fixture',
        workflowId: workId,
        input: { accounts: [person.accountId], source: 'native' },
      },
      scope: { artifactType: 'durable-work/v1', accounts: scope(person).response.accounts },
    });
    const building = await tx.query(
      `SELECT metadata_state,member_count,snapshot_digest,native_revision FROM core.record_history_source_set
       WHERE source_partition=$1 AND set_locator=$2 AND set_revision=$3`,
      recordSourceSetStorageKey(locator),
    );
    expect(building.rows[0]).toEqual({
      metadata_state: 'building',
      member_count: null,
      snapshot_digest: null,
      native_revision: locator.revision,
    });
    // Real membership becomes known after nested work serialization, before native commit.
    await producer.appendSemanticRecordSourceSet(tx, set, { sources: [source], terms: [] });
    await producer.sealSemanticRecordSourceSet(tx, set);
    return outcome.result;
  });
  if (!locator) throw new Error('Missing native locator');
  const snapshot = await producer.readSemanticRecordSourceSet({ pool: f.db.pool }, locator, {
    deadline: Date.now() + 30_000,
  });
  expect(snapshot?.locator).toEqual(locator);
  expect(snapshot?.members).toBeGreaterThan(0);
  const copies = await f.db.admin.query(
    `SELECT artifact_type,locator,original_transaction,original_position FROM core.record_history_source_set_copy
     WHERE source_partition=$1 AND set_locator=$2 AND set_revision=$3`,
    recordSourceSetStorageKey(locator),
  );
  expect(copies.rows.map((row) => row.artifact_type).sort()).toEqual(['command-receipt/v1', 'durable-work/v1']);
  for (const copy of copies.rows) {
    expect(copy.original_transaction).toBe(result.transactionId);
    expect(BigInt(copy.original_position)).toBe(result.position);
    expect(Buffer.from(encodeLocator(decodeLocator(copy.artifact_type, copy.locator)))).toEqual(copy.locator);
  }
  const work = copies.rows.find((copy) => copy.artifact_type === 'durable-work/v1');
  expect(decodeLocator('durable-work/v1', work!.locator)).toEqual({ artifactType: 'durable-work/v1', workId });
  let frontier: string | null = null;
  let found = false;
  for (let step = 0; step < 16; step++) {
    const page = await producer.pageSemanticRecordSourceSets({ pool: f.db.pool }, source, {
      frontier,
      limit: 1,
      deadline: Date.now() + 30_000,
    });
    expect(['progress', 'complete']).toContain(page.state);
    expect(page.sets.length).toBeLessThanOrEqual(1);
    if (page.frontier !== null) expect(typeof page.frontier).toBe('string');
    found ||= page.sets.some((set) => set.locator.transactionId === locator!.transactionId);
    if (found || page.state === 'complete') break;
    frontier = page.frontier;
  }
  expect(found).toBe(true);
  await command(async (tx) => {
    expect(await producer.verifySemanticRecordSourceSet(tx, locator!, snapshot!.digest)).toBe(true);
    expect(await producer.verifySemanticRecordSourceSet(tx, locator!, `${snapshot!.digest}changed`)).toBe(false);
    await declareCommandHistory(tx, kind, scope(person));
    return noEffect(null);
  });
});

test('the native seal guard rolls back building source and generated work together and rejects a different command handle', async () => {
  const producer = actualProducer();
  let handle: OwnerSourceSet | undefined;
  let locator: import('../../src/semantic/record-source-set.ts').SemanticRecordSourceSetLocator | undefined;
  const workId = randomUUID();
  await expect(
    command(async (tx) => {
      handle = await producer.beginSemanticRecordSourceSet(tx);
      locator = producer.semanticRecordSourceSetLocator(tx, handle);
      const outcome = sourceSetCommand({ payload: 'unsealed' });
      await declareCommandHistory(tx, kind, outcome.declaration);
      await stageHistoryWork(tx, {
        owner: 'record-purge-fixture',
        intent: {
          queue: 'maintenance',
          workflowName: 'record-purge-fixture',
          workflowId: workId,
          input: { accounts: [person.accountId] },
        },
        scope: { artifactType: 'durable-work/v1', accounts: scope(person).response.accounts },
      });
      await producer.appendSemanticRecordSourceSet(tx, handle, { sources: [source], terms: [] });
      return outcome.result;
    }),
  ).rejects.toThrow('Unsealed or mismatched');
  if (!locator || !handle) throw new Error('Missing attempted native set');
  expect(
    await producer.readSemanticRecordSourceSet({ pool: f.db.pool }, locator, { deadline: Date.now() + 30_000 }),
  ).toBeNull();
  expect(
    (
      await f.db.admin.query('SELECT work_id FROM core.history_work WHERE partition_no=$1 AND work_id=$2', [
        partition,
        workId,
      ])
    ).rows,
  ).toHaveLength(0);
  expect(
    (
      await f.db.admin.query(
        'SELECT locator FROM core.record_history_source_set_copy WHERE source_partition=$1 AND set_locator=$2 AND set_revision=$3',
        recordSourceSetStorageKey(locator),
      )
    ).rows,
  ).toHaveLength(0);
  await command(async (tx) => {
    expect(() => declareCommandRecordSourceSet(tx, handle!)).toThrow();
    await declareCommandHistory(tx, kind, scope(person));
    return noEffect(null);
  });
});
