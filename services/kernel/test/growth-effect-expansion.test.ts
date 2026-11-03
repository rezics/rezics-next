import { expect, test } from 'bun:test';
import { DBOS } from '@dbos-inc/dbos-sdk';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import { effectWorkflowId, launchWork, registerEffects, shutdownWork } from '../src/events/effects.ts';
import type { CloudEvent, Envelope } from '../src/events/log.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from './support/growth.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

const CREATED = 'com.rezics.subject.created.v1';
const CONTEXT = 'com.rezics.semantic.context.created.v1';
const HISTORY_SCALES = [256, 1024, 4096] as const;
const REGISTRATION_SCALES = [2, 4, 8] as const;
const REPORT_PREFIX = 'EFFECT_EXPANSION_REPORT:';
const workerScale = process.env.EFFECT_EXPANSION_CHILD;
let nextPartition = 40_000 + Math.floor(Math.random() * 256);
const freshPartition = () => nextPartition++;

type ExpansionSample = {
  scale: number;
  rows: number;
  blocks: number;
  statements: number;
  backgroundStatements: number;
  statusRows: number;
  statusInserts: number[];
  inputInserts: number[];
};

type ExpansionReport = {
  registrations: number;
  typeComparisonsPerEvent: number;
  matchingJobs: number;
  samples: ExpansionSample[];
};

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 30_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function event(subject: string, type = CREATED): CloudEvent {
  return {
    specversion: '1.0',
    id: '00000000-0000-4000-8000-000000000000',
    source: 'urn:rezics:test',
    type,
    subject,
    time: '2025-01-01T00:00:00.000Z',
    sequence: '0000000000000000001',
    datacontenttype: 'application/json',
    data: { id: subject },
  };
}

function envelope(partition: number, position: bigint, subject: string, type = CREATED): Envelope {
  return { partition, epoch: 1, position, events: [event(subject, type)] };
}

async function seedHistory(db: GrowthDatabase, namespace: string, partitionBase: number, from: number, to: number) {
  const count = (to - from) * 16;
  if (count === 0) return;
  const offset = from * 16;
  await db.admin.query(
    `WITH history AS (
       SELECT n, $1 || ':' || n::text AS workflow_uuid,
              CASE WHEN n % 10 = 0 THEN $2::text ELSE ($2::int + n % 400)::text END AS partition_key
       FROM generate_series($3::int, $4::int - 1) AS n
     ), inserted AS (
       INSERT INTO dbos.workflow_status (
         workflow_uuid, status, name, queue_name, authenticated_user, assumed_role, authenticated_roles,
         executor_id, application_id, created_at, updated_at, recovery_attempts, inputs,
         queue_partition_key, serialization
       )
       SELECT workflow_uuid, 'SUCCESS', 'effect', 'effects', '', '', '', '', 'rezics-kernel', n, n, 0,
              '[]', partition_key, 'JSON'
       FROM history
       RETURNING workflow_uuid
     ), inputs AS (
       INSERT INTO dbos.workflow_input (workflow_uuid, inputs)
       SELECT workflow_uuid, '[]' FROM inserted
     ), outputs AS (
       INSERT INTO dbos.workflow_output (workflow_uuid, output, error)
       SELECT workflow_uuid, 'null', '' FROM inserted
     )
     INSERT INTO dbos.operation_outputs (workflow_uuid, function_id, function_name, output, error)
     SELECT workflow_uuid, 1, 'effect.run', 'null', '' FROM inserted`,
    [namespace, partitionBase, offset + 1, offset + count + 1],
  );
}

function insertCounts(
  repetitions: readonly (readonly { statement: string; count: number }[])[],
  table: 'workflow_status' | 'workflow_input',
): number[] {
  const prefix = `insert into dbos.${table}`;
  return repetitions.map((statements) =>
    statements.reduce((count, { statement, count: occurrences }) => {
      const normalized = statement.replaceAll('"', '').trimStart().toLowerCase();
      return count + (normalized.startsWith(prefix) ? occurrences : 0);
    }, 0),
  );
}

async function runExpansionWorker(expansion: number): Promise<ExpansionReport> {
  const growth = await openGrowthDatabase(databaseUrl);
  const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  const matchingNames = Array.from({ length: expansion }, (_, i) => `expand_match_${String(i).padStart(2, '0')}`);
  const nonmatchingNames = Array.from({ length: expansion }, (_, i) => `expand_miss_${String(i).padStart(2, '0')}`);
  const runCounts = new Map<string, number>();
  const orderedAttempts = new Map<string, number>();
  const orderedStarts: string[] = [];
  const orderedCompletions: string[] = [];
  const recordRun = (name: string, value: CloudEvent) => {
    const key = `${name}:${value.subject}`;
    runCounts.set(key, (runCounts.get(key) ?? 0) + 1);
  };
  const definitions = [
    ...matchingNames.map((name) => ({
      name,
      types: [CREATED],
      run: async (value: CloudEvent) => recordRun(name, value),
    })),
    ...nonmatchingNames.map((name) => ({
      name,
      types: [CONTEXT],
      run: async (value: CloudEvent) => recordRun(name, value),
    })),
    {
      name: 'ordered',
      types: [CREATED],
      async run(value: CloudEvent) {
        if (value.subject === 'retry-first' || value.subject === 'retry-second') {
          const subject = value.subject;
          const attempt = (orderedAttempts.get(subject) ?? 0) + 1;
          orderedAttempts.set(subject, attempt);
          orderedStarts.push(subject);
          if (subject === 'retry-first' && attempt === 1) throw new Error('retry this ordered effect once');
          orderedCompletions.push(subject);
        }
        recordRun('ordered', value);
      },
    },
  ];
  const registrations = definitions.length;
  const typeComparisonsPerEvent = definitions.reduce((count, definition) => count + definition.types.length, 0);
  const matchingJobs = matchingNames.length + 1;
  const measuredItems: Envelope[] = [];
  const effects = registerEffects(definitions, growth.pool);
  let launched = false;

  try {
    await within(
      launchWork({ databaseUrl: databaseUrl!, systemDatabasePool: growth.openPool({ max: 4 }) }),
      'executor launch',
    );
    launched = true;
    const namespace = `effect-expansion-history:${expansion}:${crypto.randomUUID()}`;
    const partitionBase = freshPartition();
    const report = await checkGrowth(growth, {
      name: `Effect enqueue with ${registrations} registrations`,
      scales: HISTORY_SCALES,
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
      grow: (db, scale, previous) => seedHistory(db, namespace, partitionBase, previous, scale),
      async operation(_db, _scale, repetition) {
        const item = envelope(freshPartition(), BigInt(repetition + 1), 'expansion-event');
        measuredItems.push(item);
        await effects.enqueue([item]);
      },
    });

    const samples = report.samples.map((sample) => {
      const statusInserts = insertCounts(sample.statementRepetitions, 'workflow_status');
      const inputInserts = insertCounts(sample.statementRepetitions, 'workflow_input');
      expect(statusInserts.length).toBeGreaterThan(0);
      expect(statusInserts.every((count) => count === matchingJobs)).toBe(true);
      expect(inputInserts.every((count) => count === matchingJobs)).toBe(true);
      const status = sample.cost.relations['dbos.workflow_status'];
      expect(status?.rows ?? 0).toBeGreaterThanOrEqual(matchingJobs);
      expect(status?.sequentialScans ?? 0).toBe(0);
      expect(sample.cost.relations['dbos.workflow_input']?.sequentialScans ?? 0).toBe(0);
      return {
        scale: sample.scale,
        rows: sample.cost.rows,
        blocks: sample.cost.blocks,
        statements: sample.cost.statements,
        backgroundStatements: sample.cost.backgroundStatements ?? 0,
        statusRows: status?.rows ?? 0,
        statusInserts,
        inputInserts,
      };
    });

    const expectedNames = [...matchingNames, 'ordered'];
    const matchedIds = measuredItems.flatMap((item) => expectedNames.map((name) => effectWorkflowId(item, 0, name)));
    const unmatchedIds = measuredItems.flatMap((item) =>
      nonmatchingNames.map((name) => effectWorkflowId(item, 0, name)),
    );
    const persisted = await admin.query<{ workflow_uuid: string }>(
      'SELECT workflow_uuid FROM dbos.workflow_status WHERE workflow_uuid = ANY($1::text[])',
      [matchedIds],
    );
    const absent = await admin.query<{ workflow_uuid: string }>(
      'SELECT workflow_uuid FROM dbos.workflow_status WHERE workflow_uuid = ANY($1::text[])',
      [unmatchedIds],
    );
    expect(new Set(persisted.rows.map(({ workflow_uuid }) => workflow_uuid)).size).toBe(matchedIds.length);
    expect(absent.rows).toHaveLength(0);
    await Promise.all(
      measuredItems.flatMap((item) =>
        expectedNames.map((name) =>
          within(DBOS.retrieveWorkflow(effectWorkflowId(item, 0, name)).getResult(), `measured ${name} result`),
        ),
      ),
    );

    const replay = envelope(freshPartition(), 1n, 'replay-event');
    const replayIds = expectedNames.map((name) => effectWorkflowId(replay, 0, name));
    await effects.enqueue([replay]);
    await Promise.all(
      expectedNames.map((name) =>
        within(DBOS.retrieveWorkflow(effectWorkflowId(replay, 0, name)).getResult(), 'first replay result'),
      ),
    );
    const beforeReplay = await admin.query<{ status_rows: number; input_rows: number }>(
      `SELECT
         (SELECT count(*)::integer FROM dbos.workflow_status WHERE workflow_uuid = ANY($1::text[])) AS status_rows,
         (SELECT count(*)::integer FROM dbos.workflow_input WHERE workflow_uuid = ANY($1::text[])) AS input_rows`,
      [replayIds],
    );
    await effects.enqueue([replay]);
    await Promise.all(
      expectedNames.map((name) =>
        within(DBOS.retrieveWorkflow(effectWorkflowId(replay, 0, name)).getResult(), 'replayed result'),
      ),
    );
    const afterReplay = await admin.query<{ status_rows: number; input_rows: number }>(
      `SELECT
         (SELECT count(*)::integer FROM dbos.workflow_status WHERE workflow_uuid = ANY($1::text[])) AS status_rows,
         (SELECT count(*)::integer FROM dbos.workflow_input WHERE workflow_uuid = ANY($1::text[])) AS input_rows`,
      [replayIds],
    );
    expect(beforeReplay.rows).toEqual([{ status_rows: matchingJobs, input_rows: matchingJobs }]);
    expect(afterReplay.rows).toEqual(beforeReplay.rows);
    for (const name of expectedNames) expect(runCounts.get(`${name}:replay-event`)).toBe(1);

    const orderedPartition = freshPartition();
    const earlier = envelope(orderedPartition, 10n, 'retry-first');
    const later = envelope(orderedPartition, 11n, 'retry-second');
    await effects.enqueue([later, earlier]);
    await Promise.all(
      [earlier, later].map((item) =>
        within(DBOS.retrieveWorkflow(effectWorkflowId(item, 0, 'ordered')).getResult(), 'ordered retry result'),
      ),
    );
    expect(orderedStarts).toEqual(['retry-first', 'retry-first', 'retry-second']);
    expect(orderedCompletions).toEqual(['retry-first', 'retry-second']);
    expect(orderedAttempts.get('retry-first')).toBe(2);

    return { registrations, typeComparisonsPerEvent, matchingJobs, samples };
  } finally {
    if (launched) await within(shutdownWork(), 'executor shutdown');
    await growth.close();
    await admin.end();
  }
}

if (workerScale !== undefined) {
  test('native registration expansion worker', async () => {
    const report = await runExpansionWorker(Number(workerScale));
    console.log(`${REPORT_PREFIX}${JSON.stringify(report)}`);
  }, 1_200_000);
} else {
  test('Effect registration expansion, deterministic enqueue replay and failed ordered progress retain derived native bounds', async () => {
    const reports: ExpansionReport[] = [];
    for (const expansion of REGISTRATION_SCALES) {
      const child = Bun.spawn([process.execPath, 'test', fileURLToPath(import.meta.url)], {
        cwd: process.cwd(),
        env: { ...process.env, EFFECT_EXPANSION_CHILD: String(expansion) },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (exitCode !== 0) throw new Error(`Expansion worker ${expansion} failed:\n${stdout}\n${stderr}`);
      const line = stdout.split(/\r?\n/).find((entry) => entry.startsWith(REPORT_PREFIX));
      if (!line) throw new Error(`Expansion worker ${expansion} returned no report:\n${stdout}`);
      reports.push(JSON.parse(line.slice(REPORT_PREFIX.length)) as ExpansionReport);
    }

    expect(reports.map(({ registrations }) => registrations)).toEqual([5, 9, 17]);
    expect(reports.map(({ typeComparisonsPerEvent }) => typeComparisonsPerEvent)).toEqual([5, 9, 17]);
    expect(reports.map(({ matchingJobs }) => matchingJobs)).toEqual([3, 5, 9]);
    for (const report of reports) {
      expect(report.samples.map(({ scale }) => scale)).toEqual([...HISTORY_SCALES]);
      for (const sample of report.samples) {
        expect(sample.statusInserts.every((count) => count === report.matchingJobs)).toBe(true);
        expect(sample.inputInserts.every((count) => count === report.matchingJobs)).toBe(true);
      }
      console.log(
        'Effect registration expansion',
        JSON.stringify({
          registrations: report.registrations,
          typeComparisonsPerEvent: report.typeComparisonsPerEvent,
          matchingJobs: report.matchingJobs,
          samples: report.samples.map(({ scale, rows, blocks, statements, backgroundStatements }) => ({
            scale,
            rows,
            blocks,
            statements,
            backgroundStatements,
          })),
        }),
      );
    }
  }, 3_600_000);
}
