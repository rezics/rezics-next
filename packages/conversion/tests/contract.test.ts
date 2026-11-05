import { expect, test } from 'bun:test';
import {
  ConversionError,
  type SourceId,
  type SourceRecord,
  type ConversionInput,
  type ConvertedRecord,
} from '../src/index.ts';

test('conversion publishes the portable source-record contract', () => {
  const sources: SourceId[] = ['bangumi', 'vndb', 'openlibrary', 'wikidata'];
  expect(new Set(sources).size).toBe(4);
  const row: SourceRecord = { source: 'wikidata', key: 'Q42', revision: '10', payload: { id: 'Q42' } };
  const input: ConversionInput = { external_id: row.key, record_revision: row.revision, record: row.payload };
  const result: ConvertedRecord = {
    source: row.source,
    external_id: input.external_id,
    record_revision: input.record_revision,
    converter_revision: 'test-contract-v1',
    proposals: [],
    diagnostics: [],
  };
  expect(result.external_id).toBe('Q42');
  const error = new ConversionError('invalid_record', '/id');
  expect(error).toBeInstanceOf(Error);
  expect(error.code).toBe('invalid_record');
  expect(error.pointer).toBe('/id');
  expect(error.message).toMatch(/invalid_record/);
});
