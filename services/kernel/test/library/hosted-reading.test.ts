import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { ProblemError } from '../../src/http/problem-error.ts';
import {
  addressFromRow,
  parseHostedReadingPosition,
  validateHostedReadingClear,
  validateHostedReadingSave,
  type HostedReadingRow,
} from '../../src/library/hosted-reading-validate.ts';
import {
  HOSTED_READING_CHANGED_EVENT,
  HOSTED_READING_POSITION_OFFSET_MAX,
  type HostedReadingPort,
} from '../../src/library/contract/hosted-reading.ts';
import { hostedReadingUnavailable } from '../../src/content/hosted-reading-shape.ts';
import { LIBRARY_EVENTS } from '../../src/library/events.ts';

const sql = (name: string) => readFileSync(new URL(`../../src/library/${name}`, import.meta.url), 'utf8');
const eraseSql = sql('erasure-owned-hosted-reading.sql');
const exportSql = sql('hosted-reading-export.sql');
const insertSql = sql('hosted-reading-insert.sql');
const updateSql = sql('hosted-reading-update.sql');

const id = '00000000-0000-7000-8000-000000000001';
const digest = 'ab'.repeat(32);

function saveBody(overrides: Record<string, unknown> = {}) {
  return {
    subjectId: id,
    catalogueId: id,
    publicationRevisionId: id,
    occurrenceId: id,
    targetRevisionId: id,
    targetSha256: digest,
    documentPosition: { blockId: 'opening', offset: 0 },
    expectedRevision: null,
    ...overrides,
  };
}

test('save input keeps exact identities and optional bounded position', () => {
  const parsed = validateHostedReadingSave(saveBody());
  expect(parsed.documentPosition).toEqual({ blockId: 'opening', offset: 0 });
  expect(parsed.expectedRevision).toBeNull();
  expect(() => validateHostedReadingSave(saveBody({ targetSha256: 'zz' }))).toThrow(ProblemError);
  expect(() => validateHostedReadingSave(saveBody({ extra: true }))).toThrow(ProblemError);
  expect(() => parseHostedReadingPosition({ blockId: 'x'.repeat(129), offset: 0 })).toThrow(ProblemError);
  expect(() => parseHostedReadingPosition({ blockId: 'ok', offset: HOSTED_READING_POSITION_OFFSET_MAX + 1 })).toThrow(
    ProblemError,
  );
  expect(parseHostedReadingPosition(null)).toBeNull();
});

test('clear requires the stored revision fence', () => {
  expect(validateHostedReadingClear({ subjectId: id, expectedRevision: '3' })).toEqual({
    subjectId: id,
    expectedRevision: '3',
  });
  expect(() => validateHostedReadingClear({ subjectId: id, expectedRevision: null })).toThrow(ProblemError);
  expect(() => validateHostedReadingClear({ subjectId: id, expectedRevision: '0' })).toThrow(ProblemError);
});

test('stored rows round-trip the exact address without substituting a later publication', () => {
  const row: HostedReadingRow = {
    catalogue_id: id,
    publication_revision_id: '00000000-0000-7000-8000-000000000002',
    occurrence_id: '00000000-0000-7000-8000-000000000003',
    target_revision_id: '00000000-0000-7000-8000-000000000004',
    target_sha256: digest,
    document_block_id: 'block-9',
    document_offset: 44,
    revision: '2',
  };
  expect(addressFromRow(row)).toEqual({
    catalogueId: id,
    publicationRevisionId: row.publication_revision_id,
    occurrenceId: row.occurrence_id,
    targetRevisionId: row.target_revision_id,
    targetSha256: digest,
    documentPosition: { blockId: 'block-9', offset: 44 },
  });
});

test('CAS write statements compare the expected revision and do not rewrite on conflict', () => {
  expect(insertSql).toContain('ON CONFLICT (route, account_id, subject_id) DO NOTHING');
  expect(insertSql).toContain(':document_block_id::nullable(text)');
  expect(insertSql).toContain(':document_offset::nullable(integer)');
  expect(updateSql).toContain('stored.revision = input.expected_revision');
  expect(updateSql).toContain('revision = stored.revision + 1');
  expect(updateSql).toContain(':document_block_id::nullable(text)');
});

test('erasure and export hooks page owner-private checkpoints without granting read access', () => {
  expect(eraseSql).toContain('DELETE FROM library.hosted_reading');
  expect(eraseSql).toContain('LIMIT 100');
  expect(exportSql).toContain('library.hosted_reading');
  expect(exportSql).toContain('ORDER BY subject_id');
  expect(LIBRARY_EVENTS[HOSTED_READING_CHANGED_EVENT]).toBeDefined();
});

test('resume withholds bytes when current Access conceals the saved chapter and keeps the address', async () => {
  const address = addressFromRow({
    catalogue_id: id,
    publication_revision_id: id,
    occurrence_id: id,
    target_revision_id: id,
    target_sha256: digest,
    document_block_id: 'keep-me',
    document_offset: 8,
    revision: '1',
  });
  const port: HostedReadingPort = {
    async validateSelection() {
      return { ok: false, reason: 'unavailable' };
    },
    async resolveExact(_actor, saved) {
      expect(saved).toEqual(address);
      return hostedReadingUnavailable(saved.occurrenceId, 'chapter');
    },
  };
  const resume = await port.resolveExact({ kind: 'anonymous' }, address, Date.now() + 1000);
  expect(resume).toEqual({ availability: 'unavailable', occurrenceId: id, kind: 'chapter' });
  expect(address.documentPosition).toEqual({ blockId: 'keep-me', offset: 8 });
});
