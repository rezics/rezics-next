import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImportTransportError } from '../src/import-client.ts';
import {
  formatSeedFailure,
  formatSeedRemainingRequest,
  mergeRemainingRequest,
  readSeedRemainingRequest,
  remainingRequestFromPreparedCommand,
  remainingRequestFromPreparedJournal,
  remainingRequestFromTransport,
  writeSeedRemainingRequest,
} from '../src/seed-remaining-request.ts';

const command = {
  key: 'bangumi-episode-type-1',
  op: 'create',
  source: {
    source: 'rezics_reviewed_vocabulary',
    external_id: 'bangumi-episode-type-1',
    converter_revision: 'vocabulary@1',
  },
  subject: { type: 'schema:Class', labels: { en: 'private source text' } },
};
const type = 'https://rezics.com/problems/transaction_retry_exhausted';
const failure = new ImportTransportError(503, type, 'transaction_retry_exhausted', true, undefined, 'SubjectGET503', {
  method: 'GET',
  origin: 'https://api.importer.test',
  path: '/v1/subjects/00000000-0000-4000-8000-000000000101',
  phase: 'http',
  correlationId: 'req-seed-1234',
  cause: new Error('Bearer private-token in raw response text'),
});

test('remaining artifacts retain safe diagnostics and command metadata across reopen without changing prepared intent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'seed-remaining-'));
  const journalPath = join(directory, 'showcase.sqlite');
  const bytes = JSON.stringify(command);
  try {
    const database = new Database(journalPath);
    try {
      database.exec('CREATE TABLE showcase_command (command_key TEXT PRIMARY KEY, command_json TEXT, state TEXT)');
      database.query('INSERT INTO showcase_command VALUES (?, ?, ?)').run(command.key, bytes, 'prepared');
    } finally {
      database.close();
    }
    const before = await readFile(journalPath);
    const prepared = remainingRequestFromPreparedJournal(journalPath);
    expect(prepared).toEqual(remainingRequestFromPreparedCommand(command));
    const remaining = mergeRemainingRequest(prepared, remainingRequestFromTransport(failure));
    const path = await writeSeedRemainingRequest(directory, remaining);
    const reopened = await readSeedRemainingRequest(directory);
    expect(reopened).toEqual(remaining);
    expect(mergeRemainingRequest(reopened)).toEqual(remaining);
    expect(reopened).toMatchObject({
      status: 503,
      type,
      code: 'transaction_retry_exhausted',
      retryable: true,
      phase: 'SubjectGET503',
      failurePhase: 'http',
      origin: 'https://api.importer.test',
      correlationId: 'req-seed-1234',
      op: 'create',
      source: command.source.source,
      externalId: command.source.external_id,
      nativeType: 'schema:Class',
      converter: 'vocabulary@1',
      journalState: 'prepared',
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, 'utf8')).not.toContain('private');
    expect(await readFile(journalPath)).toEqual(before);

    const network = remainingRequestFromTransport(
      new ImportTransportError(undefined, undefined, undefined, false, undefined, undefined, {
        method: 'POST',
        path: '/v1/subjects:batchWrite',
        phase: 'network',
        networkCode: 'ECONNRESET',
      }),
    );
    await writeSeedRemainingRequest(directory, mergeRemainingRequest(reopened, network));
    const pending = await readSeedRemainingRequest(directory);
    expect(pending).toMatchObject({
      externalId: command.source.external_id,
      failurePhase: 'network',
      networkCode: 'ECONNRESET',
    });
    expect(pending?.status).toBeUndefined();
    expect(pending?.type).toBeUndefined();
    expect(pending?.code).toBeUndefined();
    expect(pending?.phase).toBeUndefined();
    expect(pending?.correlationId).toBeUndefined();
    expect(formatSeedRemainingRequest(pending!)).toContain('status=none type=none problem=none phase=network');
    expect(await readFile(journalPath)).toEqual(before);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('long targets cannot displace public failure fields or the exact pending tuple', () => {
  const prepared = remainingRequestFromPreparedCommand(command);
  const longTarget = new ImportTransportError(503, type, 'transaction_retry_exhausted', true, undefined, undefined, {
    method: 'POST',
    origin: `https://${'a'.repeat(180)}.test`,
    path: `/v1/${'b'.repeat(300)}`,
    phase: 'http',
  });
  const line = formatSeedFailure(longTarget, prepared);
  expect(line).toContain(`status=503 type=${type} problem=transaction_retry_exhausted phase=http`);
  expect(line).toContain('pending=create rezics_reviewed_vocabulary bangumi-episode-type-1 schema:Class');
  expect(line.length).toBeLessThanOrEqual(240);
  expect(line).not.toContain('target=');

  const externalId = 'c'.repeat(255);
  const large = formatSeedFailure(longTarget, { ...prepared, externalId });
  expect(large).toContain(`pending=create rezics_reviewed_vocabulary ${externalId} schema:Class`);
  expect(large).toContain(`type=${type}`);
  expect(large.length).toBeLessThan(1024);
});

test('artifact reads and writes exclude untrusted diagnostics, unknown fields and raw failure text', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'seed-remaining-'));
  try {
    const untrusted = {
      ...remainingRequestFromPreparedCommand(command),
      origin: 'https://user:private-token@api.importer.test',
      path: '/v1/subjects?token=private-token',
      status: 0,
      type: 'https://rezics.com/problems/failure?private-token',
      code: 'unsafe_code\n',
      phase: 'private response text',
      failurePhase: 'private response text',
      correlationId: 'req-1234\n',
      networkCode: 'private response text',
      cause: { message: 'private response text' },
      body: 'private source text',
    };
    const path = await writeSeedRemainingRequest(directory, untrusted);
    expect(await readFile(path, 'utf8')).not.toContain('private');
    const expected = await readSeedRemainingRequest(directory);
    expect(expected?.code).toBeUndefined();
    expect(expected?.correlationId).toBeUndefined();
    await writeFile(path, JSON.stringify(untrusted));
    expect(await readSeedRemainingRequest(directory)).toEqual(expected);
    const line = formatSeedFailure(new Error('private source text'), expected);
    expect(line).toContain('status=none type=none problem=none phase=unknown');
    expect(line).not.toContain('private');

    await writeFile(
      path,
      JSON.stringify({ ...remainingRequestFromPreparedCommand(command), status: 503, phase: 'readiness' }),
    );
    const legacy = await readSeedRemainingRequest(directory);
    expect(legacy?.phase).toBe('readiness');
    expect(legacy?.failurePhase).toBeUndefined();
    expect(formatSeedRemainingRequest(legacy!)).toContain('phase=unknown');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
