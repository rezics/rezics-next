import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import {
  searchReceivingOwnedStatementCosts,
  searchReceivingOwnedPageStatements,
} from '../../src/semantic/identity-search-receiving-statements.ts';
import { searchNativeReceivingStatements } from '../../src/search/identity-receiving-native-store.ts';
import {
  prepareSearchIdentityReceivingEffect,
  readSearchIdentityReceivingSelection,
  type SearchIdentityReceivingSelection,
  type SearchIdentityReceivingNative,
} from '../../src/semantic/identity-receiving-effects.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';

function input(): SearchIdentityReceivingSelection {
  const original = newId(0x8410);
  return {
    job: { jobId: newId(0x8420), epoch: 1n },
    original,
    owner: original,
    sourceId: original,
    effectKey: 'search-original-old',
    scope: 'configured-physical-original',
    disposition: 'OLD',
    native: {
      kind: 'search-canonical-index',
      version: 1,
      partition: partitionOf(routeOf(original)!),
      planId: crypto.randomUUID(),
    },
  };
}
const pool = {
  connect() {
    throw new Error('Invalid selection must not check out a client');
  },
} as unknown as Pool;

test('Search receiving refuses a caller evidence adapter before dispatch or checkout', async () => {
  let called = false;
  const native = {
    resolvePlanned() {
      called = true;
      throw new Error('Caller evidence was invoked');
    },
  } as unknown as SearchIdentityReceivingNative;
  await expect(prepareSearchIdentityReceivingEffect(pool, input(), native)).rejects.toMatchObject({
    code: 'identity_epoch_unavailable',
  });
  expect(called).toBe(false);
});

test('Search receiving refuses a wrong native step or missing native plan before checkout', async () => {
  for (const native of [
    { ...input().native, kind: 'library-private-follow-counts' },
    { ...input().native, planId: '' },
    { ...input().native, partition: -1 },
  ]) {
    await expect(
      readSearchIdentityReceivingSelection(pool, { ...input(), native } as SearchIdentityReceivingSelection, {
        deadline: Date.now() + 1000,
        allowance: { rows: 0, points: 0, statements: 0, bytes: 0, engineRequests: 0 },
      }),
    ).rejects.toMatchObject({ code: 'identity_effect_stale' });
  }
});

import { EventEmitter } from 'node:events';
import type { WorkDimensions } from '../../src/library/collection-source.ts';
import {
  receivingWorkDeclaration,
  searchReceivingOperations,
  withSearchReceivingWork,
  type SearchReceivingWork,
  type SearchReceivingWorkDeclaration,
} from '../../src/semantic/identity-search-receiving-work.ts';
import {
  withIdentitySourceConsumerMaintenance,
  identitySourceConsumerLibraryWork,
  identitySourceConsumerNativeWork,
} from '../../src/semantic/identity-source-consumer-maintenance.ts';

const zero = (): WorkDimensions => ({
  candidateKeys: 0,
  identityMetadataRows: 0,
  nativeRows: 0,
  nativePoints: 0,
  witnessKeys: 0,
  statements: 0,
  bytes: 0,
  emptySeeks: 0,
});
const nativeBound = { rows: 3, points: 2, statements: 1, bytes: 64, engineRequests: 0 };
const begin = 'BEGIN ISOLATION LEVEL SERIALIZABLE';
const nativeWrite = 'INSERT INTO native_owner VALUES ($1)';
const commonWrite = 'INSERT INTO common_receiving VALUES ($1)';
/** Driver harness for the production accountant, never a receiving evidence adapter. */
function driver(fail?: string) {
  const calls: string[] = [];
  const pool = new EventEmitter() as EventEmitter & Pool;
  const client = {
    async query(sql: string) {
      calls.push(sql);
      if (sql === fail) throw new Error('native/common write failure');
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  pool.connect = (async () => {
    pool.emit('acquire', client);
    return client;
  }) as Pool['connect'];
  return { pool, client, calls };
}
function costs(outsideSql: WorkDimensions = zero()): SearchReceivingWorkDeclaration {
  return {
    statements: [begin, 'COMMIT', 'ROLLBACK', nativeWrite, commonWrite].map((sql) => ({
      sql,
      work: sql.includes('INSERT')
        ? { ...zero(), nativeRows: 2, nativePoints: 1, statements: 1, bytes: 32 }
        : { ...zero(), statements: 1 },
    })),
    native: Object.fromEntries(
      searchReceivingOperations.map((operation) => [
        operation,
        { allowance: { ...nativeBound }, outsideSql: { ...outsideSql } },
      ]),
    ),
  };
}
const required = [begin, 'COMMIT', 'ROLLBACK', nativeWrite, commonWrite];
async function funded<T>(pool: Pool, body: (context: Parameters<typeof withSearchReceivingWork>[1]) => Promise<T>) {
  return withIdentitySourceConsumerMaintenance({ pool, env: {} }, { deadline: Date.now() + 5000 }, async (context) => {
    const parent = identitySourceConsumerLibraryWork(pool, context.identityConsumerWork, context.deadline)!;
    const ceiling: WorkDimensions = {
      candidateKeys: parent.available('candidateKeys'),
      identityMetadataRows: parent.available('identityMetadataRows'),
      nativeRows: parent.available('nativeRows'),
      nativePoints: parent.available('nativePoints'),
      witnessKeys: parent.available('witnessKeys'),
      statements: parent.available('statements'),
      bytes: parent.available('bytes'),
      emptySeeks: parent.available('emptySeeks'),
    };
    return body({
      ...context,
      ceiling,
      allowance: identitySourceConsumerNativeWork(pool, context.identityConsumerWork, context.deadline)!,
    });
  });
}

test('Search composition refuses unknown literal costs before checkout with a charged zero-work refusal', async () => {
  const { pool, calls } = driver();
  await funded(pool, async (context) => {
    const declaration = costs();
    let entered = false;
    const error = await withSearchReceivingWork(
      pool,
      context,
      receivingWorkDeclaration({ ...declaration, statements: declaration.statements.slice(1) }),
      required,
      async () => {
        entered = true;
      },
    ).catch((error) => error);
    expect(entered).toBe(false);
    expect(error.work.used).toEqual(zero());
    expect(calls).toEqual([]);
  });
});

test('Search composition transfers actual eight-axis work back to the original frame on native refusal and throw', async () => {
  for (const thrown of [false, true]) {
    const { pool } = driver();
    await funded(pool, async (context) => {
      const parent = identitySourceConsumerLibraryWork(pool, context.identityConsumerWork, context.deadline)!;
      const outside = {
        ...zero(),
        candidateKeys: 1,
        witnessKeys: 1,
        nativeRows: 5,
        nativePoints: 2,
        statements: 1,
        bytes: 128,
        emptySeeks: 1,
      };
      const before = identitySourceConsumerNativeWork(pool, context.identityConsumerWork, context.deadline)!;
      const error = await withSearchReceivingWork(
        pool,
        context,
        receivingWorkDeclaration(costs(outside)),
        required,
        async (work) => {
          const result = await work.invoke('readAndHold', async (child) => {
            expect(child.allowance).toEqual(nativeBound);
            if (thrown) throw new Error('dispatched native failure');
            return { status: 'unavailable', work: { rows: 0, points: 0, statements: 0, bytes: 0, engineRequests: 0 } };
          });
          if (result.status !== 'ready') throw new Error('charged native refusal');
        },
      ).catch((error) => error);
      expect(error.work.used).toEqual(outside);
      expect(parent.receipt()).toEqual(error.work);
      const after = identitySourceConsumerNativeWork(pool, context.identityConsumerWork, context.deadline)!;
      expect(before.rows - after.rows).toBe(nativeBound.rows);
      expect(before.bytes - after.bytes).toBe(nativeBound.bytes);
    });
  }
});

test('Search composition retains failure and rollback work instead of charging the whole residual child cap', async () => {
  const { pool, calls } = driver(commonWrite);
  await funded(pool, async (context) => {
    const parent = identitySourceConsumerLibraryWork(pool, context.identityConsumerWork, context.deadline)!;
    const error = await withSearchReceivingWork(
      pool,
      context,
      receivingWorkDeclaration(costs()),
      required,
      async () => {
        const client = await pool.connect();
        await client.query(begin);
        try {
          await client.query(nativeWrite);
          await client.query(commonWrite);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      },
    ).catch((error) => error);
    expect(calls).toEqual([begin, nativeWrite, commonWrite, 'ROLLBACK']);
    expect(error.message).toBe('native/common write failure');
    expect(error.work.used).toEqual({ ...zero(), nativeRows: 4, nativePoints: 3, statements: 4, bytes: 64 });
    expect(parent.receipt()).toEqual(error.work);
  });
});

test('Search repeated SQL dispatch respects the residual child cap and preserves reserved rollback', async () => {
  const { pool, calls } = driver();
  await funded(pool, async (context) => {
    const error = await withSearchReceivingWork(
      pool,
      { ...context, ceiling: { ...context.ceiling, nativeRows: 3 } },
      receivingWorkDeclaration(costs()),
      required,
      async () => {
        const client = await pool.connect();
        await client.query(begin);
        try {
          await client.query(nativeWrite);
          await client.query(nativeWrite);
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      },
    ).catch((error) => error);
    expect(calls).toEqual([begin, nativeWrite, 'ROLLBACK']);
    expect(error.work.used).toEqual({ ...zero(), nativeRows: 2, nativePoints: 2, statements: 3, bytes: 32 });
  });
});

test('Search work declarations are immutable and cannot fund an engine request from the old zero-engine frame', async () => {
  const { pool } = driver();
  await funded(pool, async (context) => {
    const declaration = costs();
    const frozen = receivingWorkDeclaration(declaration);
    (declaration.native.readAndHold!.allowance as { rows: number }).rows = 999;
    let escaped: SearchReceivingWork | undefined;
    const result = await withSearchReceivingWork(pool, context, frozen, required, async (work) => {
      escaped = work;
      const result = await work.invoke('readAndHold', async (child) => ({ work: child.allowance }));
      expect(result.work.rows).toBe(nativeBound.rows);
    });
    expect(result.work.used).toEqual(zero());
    await expect(escaped!.invoke('readAndHold', async (child) => ({ work: child.allowance }))).rejects.toThrow(
      'reservation has ended',
    );
  });
  await funded(pool, async (context) => {
    const declaration = costs();
    (declaration.native.readAndHold!.allowance as { engineRequests: number }).engineRequests = 1;
    let dispatched = false;
    await expect(
      withSearchReceivingWork(pool, context, receivingWorkDeclaration(declaration), required, (work) =>
        work.invoke('readAndHold', async (child) => {
          dispatched = true;
          return { work: child.allowance };
        }),
      ),
    ).rejects.toThrow('no residual native reservation');
    expect(dispatched).toBe(false);
  });
});

test('Search outer accounting spans all six native stages without a fresh allowance between released homes', async () => {
  const { pool } = driver();
  await funded(pool, async (context) => {
    const before = identitySourceConsumerNativeWork(pool, context.identityConsumerWork, context.deadline)!;
    await withSearchReceivingWork(pool, context, receivingWorkDeclaration(costs()), required, async (work) => {
      for (const operation of searchReceivingOperations) {
        await Promise.resolve();
        await work.invoke(operation, async (child) => {
          expect(child.deadline).toBe(context.deadline);
          expect(child.allowance).toEqual(nativeBound);
          return { work: child.allowance };
        });
      }
    });
    const after = identitySourceConsumerNativeWork(pool, context.identityConsumerWork, context.deadline)!;
    expect(before.rows - after.rows).toBe(nativeBound.rows * searchReceivingOperations.length);
    expect(before.statements - after.statements).toBe(nativeBound.statements * searchReceivingOperations.length);
  });
});

test('An undeclared native SQL literal refuses before dispatch while the original rollback remains funded', async () => {
  const { pool, calls } = driver();
  await funded(pool, async (context) => {
    const error = await withSearchReceivingWork(
      pool,
      context,
      receivingWorkDeclaration(costs()),
      required,
      async () => {
        const client = await pool.connect();
        await client.query(begin);
        try {
          await client.query('UPDATE undeclared_native_store SET value=1');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      },
    ).catch((error) => error);
    expect(calls).toEqual([begin, 'ROLLBACK']);
    expect(error.work.used).toEqual({ ...zero(), nativePoints: 1, statements: 2 });
  });
});

test('Failed native SQL retains candidate, witness and uncertain empty-seek charges in the original frame', async () => {
  const { pool } = driver(commonWrite);
  await funded(pool, async (context) => {
    const declaration = costs();
    const statements = declaration.statements.map((entry) =>
      entry.sql === commonWrite
        ? {
            ...entry,
            work: { ...entry.work, candidateKeys: 1, witnessKeys: 1, emptySeeks: 1 },
          }
        : entry,
    );
    const error = await withSearchReceivingWork(
      pool,
      context,
      receivingWorkDeclaration({ ...declaration, statements }),
      required,
      async () => {
        const client = await pool.connect();
        await client.query(begin);
        try {
          await client.query(commonWrite);
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      },
    ).catch((error) => error);
    expect(error.work.used).toEqual({
      ...zero(),
      nativeRows: 2,
      nativePoints: 2,
      statements: 3,
      bytes: 32,
      candidateKeys: 1,
      witnessKeys: 1,
      emptySeeks: 1,
    });
  });
});

test('Search waits for dispatched native work before settling the child when the outer body fails', async () => {
  const { pool } = driver();
  await funded(pool, async (context) => {
    let finish!: () => void;
    const completed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let started!: () => void;
    const dispatched = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finished = false;
    const attempt = withSearchReceivingWork(
      pool,
      context,
      receivingWorkDeclaration(costs({ ...zero(), nativeRows: 2 })),
      required,
      async (work) => {
        void work.invoke('reconcileOriginal', async (child) => {
          started();
          await completed;
          finished = true;
          return { work: child.allowance };
        });
        throw new Error('outer receiving failure');
      },
    ).catch((error) => error);
    await dispatched;
    let settled = false;
    void attempt.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    finish();
    const error = await attempt;
    expect(finished).toBe(true);
    expect(error.message).toBe('outer receiving failure');
    expect(error.work.used.nativeRows).toBe(2);
  });
});

test('Search snapshots the outer reservation so caller mutation cannot extend a native deadline', async () => {
  const { pool } = driver();
  await funded(pool, async (context) => {
    const mutable = { ...context, allowance: { ...context.allowance }, ceiling: { ...context.ceiling } };
    await withSearchReceivingWork(pool, mutable, receivingWorkDeclaration(costs()), required, async (work) => {
      mutable.deadline += 60000;
      mutable.allowance.rows += 1000;
      await work.invoke('resolvePlanned', async (child) => {
        expect(child.deadline).toBe(context.deadline);
        expect(child.allowance).toEqual(nativeBound);
        return { work: child.allowance };
      });
    });
  });
});

import {
  validSearchIdentityReceivingFrontier,
  SEARCH_IDENTITY_RECEIVING_FRONTIER_MAX_BYTES,
} from '../../src/search/identity-receiving-native-contract.ts';

test('Search frontiers enforce the inclusive native UTF-8 boundary and reject JSON coercions', () => {
  const overhead = Buffer.byteLength(JSON.stringify({ after: [''], segment: 0 }));
  const atLimit = { after: ['a'.repeat(SEARCH_IDENTITY_RECEIVING_FRONTIER_MAX_BYTES - overhead)], segment: 0 };
  expect(Buffer.byteLength(JSON.stringify(atLimit))).toBe(1792);
  expect(validSearchIdentityReceivingFrontier(atLimit)).toBe(true);
  expect(validSearchIdentityReceivingFrontier({ ...atLimit, after: [atLimit.after[0] + 'a'] })).toBe(false);
  const multibyte = { after: ['界'.repeat(Math.floor((1792 - overhead) / 3))], segment: 0 };
  expect(validSearchIdentityReceivingFrontier(multibyte)).toBe(true);
  expect(validSearchIdentityReceivingFrontier({ ...multibyte, after: [multibyte.after[0] + '界'] })).toBe(false);
  for (const invalid of [NaN, Infinity, -Infinity, undefined, {}, []])
    expect(
      validSearchIdentityReceivingFrontier({
        after: [invalid],
        segment: 0,
      } as unknown as import('../../src/semantic/identity-epoch-contract.ts').IdentityFrontier),
    ).toBe(false);
  expect(validSearchIdentityReceivingFrontier({ after: new Array(1), segment: 0 })).toBe(false);
  expect(validSearchIdentityReceivingFrontier({ after: Array(9).fill(null), segment: 0 })).toBe(false);
  for (const segment of [-1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    expect(validSearchIdentityReceivingFrontier({ after: [], segment })).toBe(false);
});

import { epochFixture, release, digest } from './support/identity-epoch.ts';
import { libraryCutoverInput } from './support/identity-epoch-cutover.ts';
import { identityEpochStore } from '../../src/semantic/identity-epoch-store.ts';
import { stepIdentityEpochAdmission } from '../../src/semantic/identity-epoch-admission.ts';
import { stepIdentityEpochMapping } from '../../src/semantic/identity-epoch-mapping.ts';
import { createSearchIdentityEpochParticipant } from '../../src/search/identity-epoch-participant.ts';
import { createSubjectIndex, subjectIndexName } from '../../src/search/indices.ts';
import { createOpenSearch } from '../../src/search/opensearch.ts';
import { subjectListingSource } from '../../src/library/listing-counts.ts';
import { subjectSource } from '../../src/semantic/search-source.ts';
import { createSearchWriterGuard } from '../../src/search/writer-guard.ts';
import { subjectConsumer } from '../../src/search/runner.ts';
import { subjectPartition } from '../../src/search/source.ts';

test('Search receiving uses exact native plan and held original provenance through accepted applied reconciled records while Library receiving remains distinct', async () => {
  const url = process.env.OPENSEARCH_URL;
  if (!url) throw new Error('OPENSEARCH_URL must name the check node');
  const f = await epochFixture();
  const search = createOpenSearch(url);
  const prefix = `semantic-receiving-${crypto.randomUUID().slice(0, 8)}-`;
  const index = subjectIndexName(prefix, 1);
  const routeKey = crypto.getRandomValues(new Uint8Array(32));
  let created = false;
  try {
    await createSubjectIndex(search, prefix, 1);
    created = true;
    const original = (await f.create('Search original custody', 0xe110)).id;
    const terminal = (await f.create('Search terminal first apply', 0xe120)).id;
    await libraryCutoverInput(f, [original, terminal]);
    const guard = createSearchWriterGuard({
      pool: f.pool,
      search,
      index,
      consumer: subjectConsumer(prefix, 1),
      source: subjectSource(f.pool, routeKey),
      listing: subjectListingSource(f.pool),
    });
    await guard.write(subjectPartition(original), [original], 0n);
    const actor = await f.actor();
    const key = crypto.randomUUID();
    const job = await identityEpochStore.prepareAdmission(
      f.pool,
      {
        basis: { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy },
        authorization: await f.authorization('subject:merge'),
      },
      {
        intent: { kind: 'merge', redirected: original, survivor: terminal, release: release.digest },
        receipt: {
          kind: 'subject.merge',
          command: { actorAccountId: actor.accountId, kind: 'subject.merge', key, digest: digest(key) },
        },
      },
    );
    for (let i = 0; i < 128; i++) if ((await stepIdentityEpochAdmission(f.pool, job)).state === 'pending') break;
    for (let i = 0; i < 128; i++) if ((await stepIdentityEpochMapping(f.pool, job)).state === 'complete') break;
    const participant = createSearchIdentityEpochParticipant({ search, prefix, routeKey });
    let complete = false;
    for (let i = 0; i < 128; i++)
      if ((await participant(f.pool, job)).state === 'complete') {
        complete = true;
        break;
      }
    expect(complete).toBe(true);
    const records = (
      await f.admin.query(
        `SELECT r.binding,r.native_hold,r.transaction_id,r.source_hold,
      p.transaction_id AS plan_transaction,h.accepted_transaction_id,o.state,
      e.transaction_id AS applied_transaction,c.transaction_id AS custody_transaction,g.state AS released
      FROM semantic.identity_epoch_receiving_record r
      JOIN search.identity_receiving_native_plan p ON p.partition_no=r.partition_no
       AND p.plan_id=(r.binding->'source'->'locator'->>'planId')::uuid
      JOIN search.identity_receiving_native_hold h ON (h.partition_no,h.plan_id)=(p.partition_no,p.plan_id)
      JOIN search.identity_receiving_native_operation o ON (o.partition_no,o.plan_id)=(p.partition_no,p.plan_id)
      JOIN semantic.identity_epoch_receiving_effect e ON (e.partition_no,e.job_id,e.effect_key)=(r.partition_no,r.job_id,r.effect_key)
      JOIN semantic.identity_epoch_receiving_custody c ON c.job_id=r.job_id AND c.effect_key=r.effect_key
      JOIN semantic.identity_epoch_receiving_search_progress g ON (g.partition_no,g.job_id,g.effect_key)=(r.partition_no,r.job_id,r.effect_key)
      WHERE r.job_id=$1 AND r.binding->>'step'='search-canonical-index'`,
        [job.jobId],
      )
    ).rows;
    expect(new Set(records.map((r) => r.binding.original))).toEqual(new Set([original, terminal]));
    for (const r of records) {
      expect(r.binding.source.native).toBeUndefined();
      expect(r.native_hold.source).toEqual(r.binding.source);
      expect(r.accepted_transaction_id).toBe(r.transaction_id);
      expect(r.source_hold.transactionId).toBe(r.transaction_id);
      expect(r.plan_transaction).not.toBe(r.transaction_id);
      expect(r.state).toBe('applied');
      expect(r.applied_transaction).toBeTruthy();
      expect(r.custody_transaction).toBeTruthy();
      expect(r.released).toBe('released');
    }
    expect((await identityEpochStore.readJob(f.pool, job))?.participants['library-private-follow-counts']).toBeNull();
  } finally {
    try {
      if (created) await search.request('DELETE', `/${index}`);
    } finally {
      await f.close();
    }
  }
});

test('owned native copy pages fund their explicit raw limit and retain configured transitive costs', () => {
  const statements = searchReceivingOwnedStatementCosts().map((entry) => ({
    ...entry,
    work: {
      ...entry.work,
      nativeRows: entry.work.nativeRows + 7,
      nativePoints: entry.work.nativePoints + 4,
      bytes: entry.work.bytes + 32,
    },
  }));
  const declaration = receivingWorkDeclaration({ ...costs(), statements }, searchReceivingOwnedPageStatements);
  const sql = searchNativeReceivingStatements.copies.sql;
  expect(declaration.footprint(sql, [0, 'plan', -1, 1])).toEqual({
    ...zero(),
    nativeRows: 10,
    nativePoints: 7,
    statements: 1,
    bytes: 2848,
  });
  expect(declaration.footprint(sql, [0, 'plan', -1, 100])).toEqual({
    ...zero(),
    nativeRows: 307,
    nativePoints: 205,
    statements: 1,
    bytes: 256288,
  });
  expect(declaration.footprint(sql)).toEqual(declaration.footprint(sql, [0, 'plan', -1, 100]));
  for (const limit of [-1, 101, NaN, 0.5, '1', undefined])
    expect(declaration.footprint(sql, [0, 'plan', -1, limit])).toBeUndefined();
  const insert = searchNativeReceivingStatements.insertCopies.sql;
  expect(declaration.footprint(insert, [0, 'plan', JSON.stringify([{}, {}]), 0, 'tx'])).toEqual({
    ...zero(),
    nativeRows: 9,
    nativePoints: 6,
    statements: 1,
    bytes: 5408,
  });
  for (const encoded of ['null', '{}', '[', JSON.stringify(Array(101).fill(null)), ' '.repeat(256257)])
    expect(declaration.footprint(insert, [0, 'plan', encoded, 0, 'tx'])).toBeUndefined();
});

test('a raw-page declaration cannot underfund the owned maximum before any SQL dispatch', () => {
  const statements = searchReceivingOwnedStatementCosts().map((entry) =>
    entry.sql === searchNativeReceivingStatements.copies.sql
      ? { ...entry, work: { ...entry.work, nativePoints: 200 } }
      : entry,
  );
  expect(() => receivingWorkDeclaration({ ...costs(), statements }, searchReceivingOwnedPageStatements)).toThrow(
    'Invalid receiving raw-page declaration',
  );
});

test('common SQL and the actual checkout debit both original ledgers outside a native method', async () => {
  const { pool } = driver();
  await funded(pool, async (context) => {
    const before = identitySourceConsumerNativeWork(pool, context.identityConsumerWork, context.deadline)!;
    const result = await withSearchReceivingWork(
      pool,
      context,
      receivingWorkDeclaration(costs()),
      required,
      async () => {
        const client = await pool.connect();
        try {
          await client.query(commonWrite);
        } finally {
          client.release();
        }
      },
    );
    const after = identitySourceConsumerNativeWork(pool, context.identityConsumerWork, context.deadline)!;
    expect(before.rows - after.rows).toBe(2);
    expect(before.points - after.points).toBe(2);
    expect(before.statements - after.statements).toBe(1);
    expect(before.bytes - after.bytes).toBe(32);
    expect(result.work.used).toEqual({ ...zero(), nativeRows: 2, nativePoints: 2, statements: 1, bytes: 32 });
  });
});

test('transitive SQL cannot overrun the already reserved native method even if its returned work is smaller', async () => {
  const { pool, calls } = driver();
  await funded(pool, async (context) => {
    const error = await withSearchReceivingWork(pool, context, receivingWorkDeclaration(costs()), required, (work) =>
      work.invoke('recordApplied', async () => {
        const client = await pool.connect();
        try {
          await client.query(nativeWrite);
          await client.query(commonWrite);
          return { work: { rows: 0, points: 0, statements: 0, bytes: 0, engineRequests: 0 } };
        } finally {
          client.release();
        }
      }),
    ).catch((error) => error);
    expect(error.message).toContain('original native operation reservation');
    expect(calls).toEqual([nativeWrite]);
    expect(error.work.used).toEqual({ ...zero(), nativeRows: 2, nativePoints: 2, statements: 1, bytes: 32 });
  });
});

test('an unawaited dispatched SQL failure settles before returning the original child receipt', async () => {
  const { pool, client } = driver(commonWrite);
  const query = client.query.bind(client);
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let start!: () => void;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  client.query = async (sql: string) => {
    start();
    await pending;
    return query(sql);
  };
  await funded(pool, async (context) => {
    const parent = identitySourceConsumerLibraryWork(pool, context.identityConsumerWork, context.deadline)!;
    const attempt = withSearchReceivingWork(pool, context, receivingWorkDeclaration(costs()), required, async () => {
      const acquired = await pool.connect();
      void acquired.query(commonWrite);
      return 'body returned before SQL';
    }).catch((error) => error);
    await started;
    let settled = false;
    void attempt.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    finish();
    const error = await attempt;
    expect(error.message).toBe('native/common write failure');
    expect(error.work.used).toEqual({ ...zero(), nativeRows: 2, nativePoints: 2, statements: 1, bytes: 32 });
    expect(parent.receipt()).toEqual(error.work);
  });
});

test('a late async driver callback keeps its original frame through nested SQL and fences later dispatch', async () => {
  const pool = new EventEmitter() as EventEmitter & Pool;
  let deliver!: () => void;
  let beginCallback!: () => void;
  const callbackStarted = new Promise<void>((resolve) => {
    beginCallback = resolve;
  });
  let finishCallback!: () => void;
  const callbackGate = new Promise<void>((resolve) => {
    finishCallback = resolve;
  });
  let submitted!: () => void;
  const queryStarted = new Promise<void>((resolve) => {
    submitted = resolve;
  });
  const calls: string[] = [];
  const client = {
    query(sql: string, callback?: (error: null, result: object) => unknown) {
      calls.push(sql);
      const result = { rows: [], rowCount: 0 };
      if (callback) {
        deliver = () => {
          callback(null, result);
        };
        submitted();
        return;
      }
      return Promise.resolve(result);
    },
    release() {},
  };
  pool.connect = (async () => {
    pool.emit('acquire', client);
    return client;
  }) as Pool['connect'];
  await funded(pool, async (context) => {
    let later!: () => Promise<unknown>;
    const attempt = withSearchReceivingWork(pool, context, receivingWorkDeclaration(costs()), required, async () => {
      const acquired = await pool.connect();
      acquired.query(commonWrite, async () => {
        beginCallback();
        await callbackGate;
        await acquired.query(nativeWrite);
        // Capture this callback's real inherited context, then invoke it after child settlement.
        const { AsyncResource } = await import('node:async_hooks');
        later = AsyncResource.bind(async () => acquired.query(nativeWrite));
      });
      throw new Error('outer callback failure');
    }).catch((error) => error);
    await queryStarted;
    deliver();
    await callbackStarted;
    let settled = false;
    void attempt.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    finishCallback();
    const error = await attempt;
    expect(error.message).toBe('outer callback failure');
    expect(error.work.used).toEqual({ ...zero(), nativeRows: 4, nativePoints: 3, statements: 2, bytes: 64 });
    await expect(later()).rejects.toThrow('outlived its original child reservation');
    expect(calls).toEqual([commonWrite, nativeWrite]);
  });
});

import {
  commonSearchReceivingStatements,
  searchReceivingDeferredCaptureStatements,
} from '../../src/semantic/identity-search-receiving-statements.ts';

test('a local SQL subtotal cannot admit the unresolved deferred Source capture graph as zero work', async () => {
  const { pool, calls } = driver();
  const statements = searchReceivingOwnedStatementCosts();
  const declaration = receivingWorkDeclaration({ ...costs(), statements }, searchReceivingOwnedPageStatements);
  for (const sql of searchReceivingDeferredCaptureStatements) expect(declaration.footprint(sql)).toBeUndefined();
  await funded(pool, async (context) => {
    let entered = false;
    await expect(
      withSearchReceivingWork(pool, context, declaration, commonSearchReceivingStatements, async () => {
        entered = true;
      }),
    ).rejects.toThrow('exact native/common SQL cost composition is not installed');
    expect(entered).toBe(false);
    expect(calls).toEqual([]);
  });
});

import { snapshotSearchIdentityReceivingFrontier } from '../../src/search/identity-receiving-native-contract.ts';

test('the Search frontier snapshot rejects JSON coercion and survives caller mutation before callbacks', () => {
  const original = { after: ['original', 2, null], segment: 0 };
  const saved = snapshotSearchIdentityReceivingFrontier(original);
  original.after[0] = 'changed';
  original.segment = 9;
  expect(saved).toEqual({ after: ['original', 2, null], segment: 0 });
  expect(Object.isFrozen(saved)).toBe(true);
  expect(Object.isFrozen(saved!.after)).toBe(true);
  let getter = false;
  const accessor = Object.defineProperty({ segment: 0 }, 'after', {
    enumerable: true,
    get() {
      getter = true;
      return [];
    },
  });
  const inherited = Object.assign(Object.create({ after: [] }), { segment: 0, other: 1 });
  const array = Object.assign([], { after: [], segment: 0 });
  const coerced = Object.defineProperty({ after: [], segment: 0 }, 'toJSON', { value: () => [] });
  const coercedKeys = Object.defineProperty([], 'toJSON', { value: () => ['different'] });
  for (const frontier of [accessor, inherited, array, coerced, { after: coercedKeys, segment: 0 }])
    expect(snapshotSearchIdentityReceivingFrontier(frontier)).toBeNull();
  expect(getter).toBe(false);
});
