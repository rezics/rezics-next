import { expect, test } from 'bun:test';
import type { SourceRecord } from '@rezics/conversion';
import type { BatchCommand, BatchWriteRequest, BatchWriteResult, FieldGroup, Source } from '@rezics/definitions/bulk';
import type {
  ImportBatchRequest,
  ImportBatchResult,
  ImportTransport,
  SourceRegistration,
} from '../src/import-contract.ts';

const portableSource: Source = {
  source: 'openlibrary',
  external_id: '/works/OL1W',
  record_revision: 'unversioned',
  converter_revision: 'v1',
  digest: 'a'.repeat(64),
  field_group: 'facts',
};
const portableCommand: BatchCommand = {
  op: 'propose',
  key: 'proposal-1',
  source: portableSource,
  subject: '00000000-0000-4000-8000-000000000001',
  statement: {
    property: { id: 'schema:name' },
    value: { type: 'value', content: { language: 'en', text: 'Example' } },
    references: [
      { parts: [{ property: { id: 'schema:statedIn' }, value: { type: 'value', content: 'Open Library' } }] },
    ],
  },
};
const portableRequest: BatchWriteRequest = { commands: [portableCommand] };
const portableResult: BatchWriteResult = {
  results: [
    { key: 'proposal-1', status: 201, value: { candidate: '00000000-0000-4000-8000-000000000002', revision: 1 } },
  ],
};

// These assignments ensure the private ports stay aliases of the portable bulk contract.
const importRequest: ImportBatchRequest = portableRequest;
const importResult: ImportBatchResult = portableResult;
const sourceRecord: SourceRecord = { source: 'openlibrary', key: '/works/OL1W', revision: null, payload: {} };
const fieldGroup: FieldGroup = portableSource.field_group;
const registration: SourceRegistration = {
  source: 'ol',
  sourceKind: 'openlibrary',
  converter_revision: 'v1',
  convert(_input, context) {
    const configuredAlias: string = context.source;
    void configuredAlias;
    return {
      source: 'openlibrary',
      external_id: '/works/OL1W',
      record_revision: null,
      converter_revision: 'v1',
      proposals: [portableCommand],
      diagnostics: [],
      digest: 'a'.repeat(64),
      normalized: { title: 'Example' },
    };
  },
};
const transport: ImportTransport = {
  async batchWrite(request) {
    const keys = request.commands.map(({ key }) => key);
    expect(keys).toEqual(['proposal-1']);
    return importResult;
  },
  async readFence(tuple) {
    expect(tuple.field_group).toBe(fieldGroup);
    return { fenced: false, securityRevision: '1' };
  },
};

type InventedCommand = { kind: 'write'; payload: unknown };
// @ts-expect-error Import commands must use the portable op/key/source schema.
const competingCommand: InventedCommand = portableCommand;
void competingCommand;

test('private importer contract retains the portable bulk and source types', async () => {
  expect(importRequest.commands.map(({ key }) => key)).toEqual(['proposal-1']);
  expect(importResult.results.map(({ key }) => key)).toEqual(['proposal-1']);
  expect(sourceRecord.key).toBe('/works/OL1W');
  expect(registration.source).not.toBe(registration.sourceKind);
  expect(
    await transport.readFence({ source: 'openlibrary', external_id: sourceRecord.key, field_group: fieldGroup }),
  ).toEqual({ fenced: false, securityRevision: '1' });
  expect((await transport.batchWrite(importRequest)).results[0]?.key).toBe('proposal-1');
});

test('importing the contract has no runtime network, database, or converter work', async () => {
  const module = await import('../src/import-contract.ts');
  expect(Object.keys(module)).toEqual([]);
});
