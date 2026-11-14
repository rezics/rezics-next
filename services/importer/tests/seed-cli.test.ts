import { expect, test } from 'bun:test';
import { ImportTransportError } from '../src/import-client.ts';
import { formatSeedError, SeedFinalization } from '../src/seed-cli.ts';
import { formatSeedFailure, remainingRequestFromPreparedCommand } from '../src/seed-remaining-request.ts';

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
  progress.enter('vocabulary-preparation');
  progress.failed(wrapper);
  const line = formatSeedError(wrapper);
  expect(line).toContain('status=503 type=https://rezics.com/problems/semantic_not_ready');
  expect(line).toContain('problem=semantic_not_ready phase=http classification=readiness');
  expect(line).toContain('correlation=req-ready');
  expect(line).toContain('finalization{scope=seed phase=vocabulary-preparation');
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
