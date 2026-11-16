import { beforeAll, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { Pool, QueryConfig } from 'pg';
import time from '../../src/command/time.sql';
import { installNativeHistoryPreload } from '../../src/composition/preload.ts';
import { composeSearchNativePorts } from '../../src/composition/search-native.ts';
import partitionRead from '../../src/partition/read.sql';
import { newId } from '../../src/route/route.ts';
import {
  createSearchIdentityEpochParticipant,
  searchIdentityReceivingComposition,
} from '../../src/search/identity-epoch-participant.ts';
import {
  readSearchIdentityDirectorySql,
  readSearchIdentityMaterializedOriginalSql,
  readSearchIdentityOriginalPlanSql,
} from '../../src/search/identity-search-receiving-directory-sql.ts';
import { installIdentityAdapterRuntime } from '../../src/semantic/identity-adapter-runtime.ts';
import {
  identityChangeFirstInputsSQL,
  identityChangeTransformSQL,
} from '../../src/semantic/identity-epoch-store-change-transform.ts';
import ackRead from '../../src/semantic/identity-epoch-store-select-ack.sql';
import jobRead from '../../src/semantic/identity-epoch-store-select-job.sql';
import originals from '../../src/semantic/identity-epoch-store-select-original.sql';
import { searchReceivingCaptureStatements } from '../../src/semantic/identity-search-receiving-capture.ts';
import { searchReceivingProductionDeclaration } from '../../src/semantic/identity-search-receiving-statements.ts';
import { withIdentitySourceConsumerMaintenance } from '../../src/semantic/identity-source-consumer-maintenance.ts';

beforeAll(() => {
  installNativeHistoryPreload();
  installIdentityAdapterRuntime();
});

const directoryScope = 'd'.repeat(64);
const jobHome = 0x842;
const writerHome = 0x841;
const otherControlHome = 0x843;
const prefix = 'directory-probe-';
const index = prefix + 'subjects-g1';

test.each([
  { label: 'selects the initial merge key', intent: 'merge', resumed: false, mode: 'input' },
  { label: 'resumes unmerge from the checkpoint', intent: 'unmerge', resumed: true, mode: 'input' },
  { label: 'includes an older materialized key', intent: 'merge', resumed: true, mode: 'materialized' },
  { label: 'refuses a stale checkpoint', intent: 'merge', resumed: true, mode: 'stale' },
  { label: 'refuses a moved input control home', intent: 'merge', resumed: true, mode: 'moved' },
  { label: 'refuses an unproved empty directory', intent: 'merge', resumed: false, mode: 'empty' },
  { label: 'refuses replacement of the checkpoint during sealing', intent: 'merge', resumed: true, mode: 'changed' },
])('installed Search directory $label', async ({ intent, resumed, mode }) => {
  const [previous, first, second] = Array.from({ length: 3 }, () => newId(writerHome << 4)).sort() as [
    string,
    string,
    string,
  ];
  const jobId = newId(jobHome << 4);
  const job = { jobId, epoch: 1n };
  const savedJob = { jobId, epoch: '1' };
  const after = resumed ? previous : null;
  const frontier = resumed ? { after: ['search-directory', previous, 9], segment: 0 } : null;
  const leftGeneration = newId(jobHome << 4);
  const rightGeneration = newId(jobHome << 4);
  const selected = mode === 'materialized' ? first : intent === 'unmerge' ? second : first;
  const pool = new EventEmitter() as EventEmitter & Pool;
  const forbidden = () => {
    throw new Error('Unexpected Access or Pool call');
  };
  pool.query = forbidden;
  const checkpoint = crypto.randomUUID();
  const replacement = crypto.randomUUID();
  let directoryReads = 0;
  let originalReads = 0;
  let planReads = 0;
  let engineReads = 0;
  const client = {
    async query(input: string | QueryConfig, positional: unknown[] = []) {
      const sql = typeof input === 'string' ? input : input.text;
      const values = typeof input === 'string' ? positional : (input.values ?? []);
      let rows: readonly unknown[];
      if (sql === partitionRead.sql) rows = [[String(values[0]), 'b', 'active', null, '1', '0']];
      else if (sql === jobRead.sql)
        rows = [
          {
            state: 'pending',
            intent: {
              kind: intent,
              original: second,
              redirected: first,
              survivor: second,
              undoJob: savedJob,
              release: 'fixture',
            },
            receipt: { kind: 'subject.merge', command: { digest: 'AA==' } },
          },
        ];
      else if (sql === ackRead.sql)
        rows = [
          {
            step: 'mapping',
            progress: { state: 'complete', job: savedJob, receipt: { job: savedJob, native: { position: '1' } } },
          },
        ];
      else if (sql === readSearchIdentityDirectorySql) {
        expect(values).toEqual([jobHome, jobId, '1']);
        directoryReads++;
        rows = [
          {
            scope_digest: directoryScope,
            transaction_id: !resumed ? null : directoryReads === 1 ? checkpoint : replacement,
            frontier,
            proven: mode !== 'stale',
          },
        ];
      } else if (sql === identityChangeTransformSQL)
        rows = [{ kind: intent, original: second, survivor: second, remainder_terminal: first }];
      else if (sql === identityChangeFirstInputsSQL) {
        rows = [{ generation: rightGeneration, terminal: second, control_partition: jobHome, owner_current: true }];
        if (intent === 'merge')
          rows = [
            {
              generation: leftGeneration,
              terminal: first,
              control_partition: otherControlHome,
              owner_current: mode !== 'moved',
            },
            ...rows,
          ];
      } else if (sql === originals.sql) {
        originalReads++;
        const original = values[0] === leftGeneration && mode !== 'materialized' ? first : second;
        const isLeft = values[0] === leftGeneration;
        expect(values).toEqual([values[0], after, 1, isLeft ? first : second, isLeft ? otherControlHome : jobHome]);
        rows =
          mode === 'empty' || mode === 'changed' || (mode === 'materialized' && values[0] === leftGeneration)
            ? []
            : [{ original, terminal: original }];
      } else if (sql === readSearchIdentityMaterializedOriginalSql) {
        expect(values).toEqual([jobHome, jobId, after]);
        rows = mode === 'materialized' ? [{ original: first, previous_terminal: first, terminal: second }] : [];
      } else if (sql === readSearchIdentityOriginalPlanSql) {
        expect(values).toEqual([
          writerHome,
          jobId,
          '1',
          ['OLD', 'NEW', 'first-apply', 'handoff'].map(
            (disposition) => `search_directory_probe_subjects_g1:${selected}:${disposition}`,
          ),
          selected,
          index,
        ]);
        planReads++;
        rows = [];
      } else if (sql === time['~standard'].query.text) rows = [['2026-01-01T00:00:00.000Z']];
      else if (
        sql.startsWith('SELECT l.account_id::text,l.role FROM semantic.identity_epoch_job j') ||
        [
          'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
          'BEGIN ISOLATION LEVEL SERIALIZABLE',
          'COMMIT',
          'ROLLBACK',
          "SET LOCAL lock_timeout = '200ms'",
          searchReceivingCaptureStatements.enable,
        ].includes(sql) ||
        sql.startsWith('SET LOCAL statement_timeout')
      )
        rows = [];
      else throw new Error(`Unexpected driver query ${sql}`);
      return { rows, rowCount: rows.length };
    },
    release() {},
  };
  pool.connect = (async () => {
    pool.emit('acquire', client);
    return client;
  }) as Pool['connect'];
  const search = {
    async request(method: string, path: string): Promise<never> {
      expect([method, path]).toEqual(['GET', `/${index}`]);
      engineReads++;
      throw new Error('Driver reached the selected writer');
    },
    bulk: forbidden,
  };
  const routeKey = new Uint8Array(32);
  const receiving = searchIdentityReceivingComposition({
    pool,
    search,
    prefix,
    routeKey,
    access: { authorize: forbidden, authenticate: forbidden } as never,
    clock: () => new Date(),
    identitySourceSupportReaderFactory: composeSearchNativePorts().createIdentitySourceSupportReader,
    work: searchReceivingProductionDeclaration(),
  });
  const step = createSearchIdentityEpochParticipant({ search, prefix, routeKey, receiving });
  const result = withIdentitySourceConsumerMaintenance({ pool, env: {} }, { deadline: Date.now() + 5000 }, () =>
    step(pool, job),
  );
  const reachedWriter = mode === 'input' || mode === 'materialized';
  await expect(result).rejects.toThrow(
    mode === 'stale' || mode === 'changed'
      ? 'checkpoint changed'
      : mode === 'empty'
        ? 'no completed original'
        : mode === 'moved'
          ? 'closure is not current'
          : 'Driver reached the selected writer',
  );
  expect(directoryReads).toBe(mode === 'changed' ? 2 : 1);
  expect(originalReads).toBe(mode === 'stale' || mode === 'moved' ? 0 : intent === 'merge' ? 2 : 1);
  expect(planReads).toBe(reachedWriter ? 1 : 0);
  expect(engineReads).toBe(reachedWriter ? 1 : 0);
});
