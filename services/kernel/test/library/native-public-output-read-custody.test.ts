import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool, PoolClient, QueryConfig } from 'pg';
import { withConnection } from '../../src/database/pool.ts';
import { NativeCollectionWork, instrumentNativeCollectionWork } from '../../src/library/collection-native-work.ts';
import { nativeCollectionFootprint } from '../../src/library/collection-source-native.ts';
import { createNativePublicOutputCustody } from '../../src/library/native-public-output-custody.ts';
import bindingSQL from '../../src/library/native-public-output-binding.sql';
import xminSQL from '../../src/library/native-public-output-binding-xmin.sql';
import provenanceSQL from '../../src/library/native-public-output-provenance.sql';
import successorSQL from '../../src/library/native-public-output-frozen-successor-read.sql';
import { newId, partitionOf } from '../../src/route/route.ts';
import { outputCaptureFootprint, publicOutputReadWork } from '../../src/semantic/identity-public-output-work.ts';
import { withReadTransaction } from '../../src/semantic/read.ts';

test.each(['COMMIT', 'ROLLBACK'] as const)(
  'a frozen successor read leaves %s and connection reuse to the snapshot owner',
  async (terminal) => {
    const route = 0;
    const collectionId = newId(route);
    const generation = randomUUID();
    const observation = { partition: partitionOf(route), epoch: 1, position: '2' };
    const accepted = { ...observation, transactionId: randomUUID() };
    const activation = { transactionId: randomUUID(), position: '1', sourceGeneration: '3' };
    const tuple = {
      identity: {
        scope: 'public_output' as const,
        route,
        collectionId,
        incarnation: `${collectionId}:1`,
        generation: activation.sourceGeneration,
        receivingEpoch: '1',
        ownerEpoch: observation.epoch,
        effectKey: 'a'.repeat(64),
        outputGeneration: generation,
        activation,
      },
      publication: { ...activation, generation, nativeXid: '123', memberFence: '1', members: '2' },
      observation,
    };
    const body = { captureId: randomUUID(), holdId: randomUUID(), definitionDigest: 'b'.repeat(64), tuple, accepted };
    const bindingDigest = createHash('sha256').update(canonicalize(body)!).digest('hex');
    const binding = {
      ...body,
      bindingDigest,
      tuple: { ...tuple, observation: { ...observation, position: 2n } },
      accepted: { ...accepted, position: 2n },
    };
    const rows = new Map<string, unknown[]>([
      [bindingSQL.sql, [{ ...accepted, payload: { ...body, bindingDigest }, bindingDigest, nativeXid: '123' }]],
      [xminSQL.sql, [{ xmin: '123' }]],
      [provenanceSQL.sql, [{ '?column?': 1 }]],
      [successorSQL.sql, [{ '?column?': 1 }]],
    ]);
    const begin = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY';
    const statements: string[] = [];
    const physical = {
      async query(config: string | QueryConfig) {
        const sql = typeof config === 'string' ? config : config.text;
        statements.push(sql);
        return { rows: rows.get(sql) ?? [] };
      },
      release: () => {},
    } as unknown as PoolClient;
    const pool = { connect: async () => physical } as unknown as Pool;
    const native = createNativePublicOutputCustody({
      observe: async () => null,
      lockDisposition: async () => {
        throw new Error('A frozen read must not lock a disposition');
      },
    });
    const deadline = Date.now() + 5000;
    const allowance = { reservationId: randomUUID(), remaining: publicOutputReadWork(1) };
    const work = new NativeCollectionWork(allowance, deadline);
    const refused = new Error('Page refused after successor validation');

    const page = instrumentNativeCollectionWork(
      pool,
      work,
      (sql, values) => outputCaptureFootprint(work, sql, values),
      () =>
        withReadTransaction(
          pool,
          async (snapshot) => {
            const result = await work.compose((allowance) =>
              native.readNativeFrozenCollectionOutputSuccessor(snapshot, binding, { pool, allowance, deadline }),
            );
            expect(result.status).toBe('current');
            if (terminal === 'ROLLBACK') throw refused;
          },
          deadline,
        ),
    );
    if (terminal === 'ROLLBACK') await expect(page).rejects.toBe(refused);
    else await page;

    await instrumentNativeCollectionWork(
      pool,
      new NativeCollectionWork(allowance, deadline),
      nativeCollectionFootprint,
      () =>
        withConnection(pool, async (client) => {
          await client.query(begin);
          await client.query('COMMIT');
        }),
    );
    expect(statements).toEqual([
      begin,
      expect.stringMatching(/^SET LOCAL statement_timeout/),
      ...rows.keys(),
      terminal,
      begin,
      'COMMIT',
    ]);
    work.close();
  },
);
