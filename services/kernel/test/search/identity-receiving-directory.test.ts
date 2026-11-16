import { beforeAll, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { Pool, QueryConfig } from 'pg';
import time from '../../src/command/time.sql';
import commandFence from '../../src/command/fence.sql';
import { installNativeHistoryPreload } from '../../src/composition/preload.ts';
import { composeSearchNativePorts } from '../../src/composition/search-native.ts';
import partitionRead from '../../src/partition/read.sql';
import { newId } from '../../src/route/route.ts';
import stepSql from '../../src/search/identity-epoch-participant-step.sql';
import { createSearchIdentityWriterPreparation } from '../../src/search/identity-search-writer-preparation.ts';
import {
  insertWriterPublicationWitness,
  lockPublicationAdmission,
  readPublicationFence,
  readWriterPublicationWitness,
} from '../../src/search/publication-admission.ts';
import { searchIdentityWriterAdmissionSql } from '../../src/search/writer-guard.ts';
import { SEARCH_IDENTITY_WRITER_REQUEST } from '../../src/semantic/contract/identity-epoch-ports.ts';
import { identityEpochReceiptLocator } from '../../src/semantic/core/identity-epoch-sequence.ts';
import nativeCommit from '../../src/semantic/identity-epoch-store-insert-native-commit.sql';
import structuralGate from '../../src/semantic/identity-epoch-store-select-home-gate.sql';
import type { IdentityFrontier } from '../../src/semantic/identity-epoch-contract.ts';
import {
  createSearchIdentityEpochParticipant,
  searchIdentityReceivingComposition,
} from '../../src/search/identity-epoch-participant.ts';
import {
  readSearchIdentityDirectorySql,
  readSearchIdentityMaterializedOriginalSql,
  readSearchIdentityOriginalPlanSql,
  readSearchIdentityWriterAdmissionSql,
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
import {
  activeIdentitySourceConsumerMaintenance,
  withIdentitySourceConsumerMaintenance,
} from '../../src/semantic/identity-source-consumer-maintenance.ts';

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
const alias = `${index}-writer-${'a'.repeat(32)}`;

test.each([
  { label: 'selects the initial merge key', intent: 'merge', resumed: false, mode: 'input' },
  { label: 'uses the existing writer admission witness and gate', intent: 'merge', resumed: false, mode: 'existing' },
  { label: 'preserves an active publication fence', intent: 'merge', resumed: false, mode: 'fenced' },
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
  let checkedOut = false;
  const writerSql = searchIdentityWriterAdmissionSql();
  const locks = [
    structuralGate.sql,
    lockPublicationAdmission,
    readWriterPublicationWitness,
    insertWriterPublicationWitness,
    readPublicationFence,
    writerSql.gate,
    writerSql.insertGate,
    writerSql.original,
  ];
  const observedLocks: string[] = [];
  type Step = { transactionId: string; frontier: IdentityFrontier; engineRequests: number };
  let writing: Step | undefined;
  const committed: Step[] = [];
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
        const saved = committed.find((step) => step.frontier.after[0] === 'search-directory');
        rows = [
          {
            scope_digest: directoryScope,
            transaction_id:
              saved?.transactionId ??
              (!resumed ? null : mode === 'changed' && directoryReads > 1 ? replacement : checkpoint),
            native_epoch: 1,
            native_position: '1',
            frontier: saved?.frontier ?? frontier,
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
      } else if (sql === readSearchIdentityWriterAdmissionSql) {
        expect(values).toEqual([writerHome, jobId, '1', committed[0]?.transactionId, directoryScope, selected]);
        rows = committed.some((step) => step.frontier.after[0] === 'search-writer-admitted') ? [{ proven: true }] : [];
      } else if (locks.includes(sql)) {
        observedLocks.push(sql);
        if (sql === structuralGate.sql) rows = [{ pending_job: jobId, pending_epoch: '1' }];
        else if (sql === readWriterPublicationWitness && (mode === 'existing' || mode === 'fenced')) rows = [{}];
        else if (sql === readPublicationFence && mode === 'fenced') rows = [{ publication_fence: crypto.randomUUID() }];
        else if (sql === writerSql.insertGate || (sql === writerSql.gate && mode === 'existing'))
          rows = [{ enrollment_generation: '0', fence_generation: '0', closed_token: null }];
        else rows = [];
      } else if (sql === stepSql.sql) {
        const work = JSON.parse(String(values[6]));
        writing = {
          transactionId: String(values[1]),
          frontier: JSON.parse(String(values[5])),
          engineRequests: work.engineRequests,
        };
        rows = [{ transaction_id: writing.transactionId }];
      } else if (sql === 'COMMIT') {
        if (writing) committed.push(writing);
        writing = undefined;
        rows = [];
      } else if (sql === nativeCommit.sql) rows = [{}];
      else if (sql === commandFence['~standard'].query.text) rows = [['1', '1']];
      else if (sql === time['~standard'].query.text) rows = [['2026-01-01T00:00:00.000Z']];
      else if (
        sql.startsWith('SELECT l.account_id::text,l.role FROM semantic.identity_epoch_job j') ||
        sql.startsWith('INSERT INTO semantic.erasure_source_role') ||
        sql.startsWith("SELECT set_config('semantic.erasure_native_transaction'") ||
        sql.startsWith("SELECT set_config('semantic.identity_prearm_effect_job'") ||
        sql === searchReceivingCaptureStatements.next ||
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
    release() {
      checkedOut = false;
    },
  };
  pool.connect = (async () => {
    checkedOut = true;
    pool.emit('acquire', client);
    return client;
  }) as Pool['connect'];
  const search = {
    async request<T>(method: string, path: string) {
      expect([method, path]).toEqual(['GET', `/${index}`]);
      expect(checkedOut).toBe(false);
      expect(activeIdentitySourceConsumerMaintenance(pool)).toBeNull();
      engineReads++;
      return {
        status: 200,
        body: {
          [index]: {
            settings: { index: { uuid: 'allocation' } },
            aliases: { [alias]: { is_write_index: true } },
          },
        } as T,
      };
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
  const requestsWriter = ['input', 'materialized', 'existing', 'fenced'].includes(mode);
  if (!requestsWriter) {
    await expect(result).rejects.toThrow(
      mode === 'stale' || mode === 'changed'
        ? 'checkpoint changed'
        : mode === 'empty'
          ? 'no completed original'
          : 'closure is not current',
    );
    expect(directoryReads).toBe(mode === 'changed' ? 2 : 1);
    expect(originalReads).toBe(mode === 'stale' || mode === 'moved' ? 0 : 2);
    expect(planReads).toBe(0);
    expect(committed).toEqual([]);
  } else {
    const progress = await result;
    expect(progress.state).toBe('more');
    expect(identityEpochReceiptLocator(job, 'search-canonical-index', progress).ok).toBe(true);
    expect(progress.frontier.after.slice(3, 5)).toEqual([SEARCH_IDENTITY_WRITER_REQUEST, selected]);
    expect(progress.work.engineRequests).toBe(0);
    expect(committed.map((step) => step.engineRequests)).toEqual([0]);
    expect(directoryReads).toBe(2);
    expect(originalReads).toBe(intent === 'merge' ? 4 : 2);
    expect(planReads).toBe(1);
    if (!resumed) {
      const prepare = createSearchIdentityWriterPreparation(receiving, {});
      await expect(
        withIdentitySourceConsumerMaintenance({ pool, env: {} }, { deadline: Date.now() + 5000 }, () =>
          prepare(pool, progress.receipt),
        ),
      ).rejects.toThrow('requires the separate owner turn');
      const replay = await withIdentitySourceConsumerMaintenance(
        { pool, env: {} },
        { deadline: Date.now() + 5000 },
        () => step(pool, job),
      );
      expect(replay.receipt).toEqual(progress.receipt);
      expect(replay.frontier).toEqual(progress.frontier);
      const stale = { ...progress.receipt, native: { ...progress.receipt.native, position: 2n } };
      await expect(prepare(pool, stale)).rejects.toThrow('no longer the retained current step');
      expect(engineReads).toBe(0);
      if (mode === 'fenced') {
        await expect(prepare(pool, progress.receipt)).rejects.toThrow('fenced for native publication');
        expect(committed).toHaveLength(1);
        expect(engineReads).toBe(1);
        expect(observedLocks).toEqual([
          structuralGate.sql,
          lockPublicationAdmission,
          readWriterPublicationWitness,
          readPublicationFence,
        ]);
        return;
      }
      expect(await prepare(pool, progress.receipt)).toBe('pending');
      expect(committed[1]?.frontier.after).toEqual([
        'search-writer-admitted',
        progress.receipt.native.transactionId,
        selected,
        'allocation',
        alias,
        '0',
        '0',
        null,
      ]);
      expect(committed.map((step) => step.engineRequests)).toEqual([0, 1]);
      expect(engineReads).toBe(1);
      expect(observedLocks).toEqual(
        mode === 'existing'
          ? locks.filter(
              (statement) => statement !== insertWriterPublicationWitness && statement !== writerSql.insertGate,
            )
          : locks,
      );
      expect(await prepare(pool, progress.receipt)).toBe('pending');
      expect(engineReads).toBe(1);
      expect(committed).toHaveLength(2);
      return;
    }
  }
  expect(engineReads).toBe(0);
});
