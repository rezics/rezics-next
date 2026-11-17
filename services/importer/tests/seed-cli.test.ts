import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { ImportTransportError } from '../src/import-client.ts';
import { Importer } from '../src/importer.ts';
import { formatSeedError, SeedFinalization, seedImportRunFailure } from '../src/seed-cli.ts';
import { formatSeedFailure, remainingRequestFromPreparedCommand } from '../src/seed-remaining-request.ts';
import { createSourceRegistration } from '../src/source-registry.ts';
import { sourceRecordMetadataFixture } from './transport-driver.ts';

test('seed phase wrappers retain the transport classifier, actual failure phase and private cause', () => {
  const cause = new Error('private response body');
  const transport = new ImportTransportError(
    503,
    'https://rezics.com/problems/semantic_not_ready',
    'semantic_not_ready',
    true,
    undefined,
    'readiness',
    { phase: 'http', method: 'GET', path: '/v1/subjects/example', correlationId: 'req-ready', cause },
  );
  const wrapper = new Error('private phase wrapper text', { cause: transport });
  const progress = new SeedFinalization('seed', () => {});
  progress.enter('record-import');
  const recordImport = new SeedFinalization('record-import', () => {});
  recordImport.enter('bangumi-character-fidelity');
  recordImport.failed(wrapper);
  progress.failed(wrapper);
  const line = formatSeedError(wrapper);
  expect(line).toContain('status=503 type=https://rezics.com/problems/semantic_not_ready');
  expect(line).toContain('problem=semantic_not_ready phase=http classification=readiness');
  expect(line).toContain('correlation=req-ready');
  expect(line).toContain('finalization{scope=record-import phase=bangumi-character-fidelity');
  expect(line).toContain('finalization{scope=seed phase=record-import');
  expect(line).not.toContain('private');
  expect(wrapper.cause).toBe(transport);
  expect(transport.cause).toBe(cause);
  const pending = remainingRequestFromPreparedCommand({
    op: 'create',
    source: { source: 'bangumi', external_id: 'bangumi-episode-type-1', converter_revision: 'vocabulary@1' },
    subject: { type: 'schema:Class' },
  });
  expect(formatSeedFailure(wrapper, pending)).toContain('problem=semantic_not_ready phase=http');
  expect(formatSeedFailure(wrapper, pending)).toContain('pending=create bangumi bangumi-episode-type-1 schema:Class');
});

test('seed failure formatting never reads raw error messages or invokes cause accessors', () => {
  const untrusted = new Error('Bearer private-token with raw source text');
  Object.defineProperty(untrusted, 'cause', {
    get() {
      throw new Error('cause accessor must not run');
    },
  });
  expect(formatSeedFailure(untrusted)).toBe('Cross-media seed failed');
  expect(formatSeedError(untrusted)).toBe('Cross-media seed failed');
  const cyclic = new Error('private text');
  Object.defineProperty(cyclic, 'cause', { value: cyclic });
  expect(formatSeedError(cyclic)).toBe('Cross-media seed failed');
});

test('a native command refusal includes its status and key digest in the seed failure', async () => {
  let key = '';
  const importer = new Importer({
    path: new Database(':memory:'),
    transport: {
      async readFence() {
        return { fenced: false, securityRevision: null };
      },
      async batchWrite(request) {
        key = request.commands[0]!.key;
        return {
          results: [
            {
              key,
              status: 422,
              problem: {
                type: 'about:blank',
                title: 'private title',
                detail: 'private detail',
                status: 422,
                retryable: false,
                code: 'invalid_statement',
              },
            },
          ],
        };
      },
    },
  });
  try {
    const run = await importer.runRecords(
      createSourceRegistration('bangumi'),
      (async function* () {
        yield { source: 'bangumi', key: '101', revision: null, payload: { id: 101, type: 2, name: 'Anime' } };
      })(),
    );
    const line = formatSeedError(seedImportRunFailure('bangumi', run));
    expect(line).toContain(
      `run{phase=bootstrap reason=command-refused keyDigest=${createHash('sha256').update(key).digest('hex')} status=422 problem=invalid_statement}`,
    );
    expect(line).not.toContain(key);
    expect(line).not.toContain('private');
  } finally {
    await importer.close();
  }
});

test('a staged Books command refusal keeps only bounded diagnostics for the rejected command', async () => {
  const subject = '00000000-0000-7000-8000-000000000001';
  let key = '';
  const importer = new Importer({
    path: new Database(':memory:'),
    transport: {
      setSourceRecordMetadata: sourceRecordMetadataFixture().setSourceRecordMetadata,
      async readFence() {
        return { fenced: false, securityRevision: null };
      },
      async batchWrite(request) {
        return {
          results: request.commands.map((command) => {
            if (command.op === 'create') return { key: command.key, status: 201, value: { id: subject, revision: 1 } };
            key ||= command.key;
            return {
              key: command.key,
              status: 500,
              problem: {
                type: 'https://rezics.com/problems/internal_error',
                title: 'private title',
                detail: 'private provider text',
                status: 500,
                retryable: false,
                code: 'internal_error',
                request_id: 'books-request',
                command_index: 0,
                failure_stage: 'source_fence',
                phase: 'transaction_body',
              },
            };
          }),
        };
      },
    },
  });
  try {
    const run = await importer.runRecords(
      createSourceRegistration('bangumi'),
      (async function* () {
        yield {
          source: 'bangumi',
          key: '999',
          revision: null,
          payload: { id: 999, type: 1, name: 'Book', summary: 'private summary' },
        };
      })(),
    );
    const line = formatSeedError(seedImportRunFailure('bangumi', run));
    expect(line).toContain(
      `run{phase=staged reason=command-refused keyDigest=${createHash('sha256').update(key).digest('hex')} status=500 problem=internal_error}`,
    );
    expect(line).toContain('batch{op=propose fieldGroup=facts');
    expect(line).toContain(
      'correlation=books-request index=0 failureStage=source_fence dominantPhase=transaction_body}',
    );
    expect(line).not.toContain(key);
    expect(line).not.toContain('private');
  } finally {
    await importer.close();
  }
});
