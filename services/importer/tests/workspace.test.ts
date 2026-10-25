import { expect, test } from 'bun:test';
import { ConversionError, type SourceRecord } from '@rezics/conversion';

test('importer consumes the shared record contract without kernel dependencies', () => {
  const row: SourceRecord = { source: 'openlibrary', key: '/works/OL1W', revision: null, payload: {} };
  expect(row.revision).toBeNull();
  expect(new ConversionError('invalid_record', '/key').code).toBe('invalid_record');
});
