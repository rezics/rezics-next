import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  ArchiveValidationError,
  decodeLibraryArchive,
  LIBRARY_ARCHIVE_LIMITS,
  type ArchiveRecord,
  type ArchiveValidationCode,
} from '../../src/library/library-archive.ts';
import { libraryExportManifest } from '../../src/library/library-export-format.ts';

const first = randomUUID(),
  second = randomUUID(),
  label = randomUUID();
const at = '2026-01-01 00:00:00.123456+00';
const reference = (id: string) => ({ id, href: `https://rezics.com/subjects/${id}` });
function entry(subject: string, state = 'retired-vocabulary') {
  return {
    section: 'entries' as const,
    subject_id: subject,
    requested_subject_id: null,
    incarnation_id: null,
    state,
    revision: 7,
    library_profile_pin: null,
    created_at: at,
    updated_at: at,
    activity_at: null,
    finished_at: null,
    subject_id_reference: reference(subject),
  };
}
function named(id = label, name = 'weekend') {
  return { section: 'labels' as const, label_id: id, normalized_name: name, revision: 2, created_at: at, updated_at: at };
}
function assignment() {
  return {
    section: 'assignments' as const,
    subject_id: first,
    label_id: label,
    assignment_id: null,
    revision: 1,
    created_at: at,
    updated_at: at,
    subject_id_reference: reference(first),
  };
}
function archive(records: ArchiveRecord[] = [entry(first), entry(second, 'planned'), named(), assignment()]) {
  return {
    manifest: {
      ...libraryExportManifest({
        export_id: randomUUID(),
        created_at: at,
        expires_at: '2026-01-01 00:15:00.123456+00',
      }),
      fullExport: false,
      rows: records.length,
      recordBytes: records.reduce((bytes, row) => bytes + Buffer.byteLength(JSON.stringify(row)), 0),
    },
    records,
  };
}
const decode = (value: unknown) => decodeLibraryArchive(Buffer.from(JSON.stringify(value)));
function refuses(value: unknown, code: ArchiveValidationCode) {
  expect(() => decode(value)).toThrow(new ArchiveValidationError(code));
}

test('completed installed manifest preserves old meanings, explicit emptiness and unsupported evidence', () => {
  const file = archive([
    entry(first),
    entry(second),
    named(),
    assignment(),
    { section: 'sessions', session_id: randomUUID(), amount: '12.50', state: 'completed' },
  ]);
  const decoded = decode(file);
  expect(decoded.records).toEqual(file.records);
  expect(decoded.manifest.omissions).toEqual(file.manifest.omissions);
  expect(decoded.fullRestoration).toBe(false);
  expect(decoded.coverage.find((s) => s.section === 'entries')).toEqual({
    section: 'entries',
    rows: 2,
    capture: 'present',
    treatment: 'requires-explicit-mapping',
  });
  expect(decoded.coverage.find((s) => s.section === 'sessions')).toMatchObject({
    capture: 'present',
    treatment: 'retained-unsupported',
    rows: 1,
  });
  expect(decoded.coverage.find((s) => s.section === 'holdings')).toMatchObject({
    capture: 'empty',
    treatment: 'retained-unsupported',
    rows: 0,
  });
  expect(decode(archive([])).coverage.every((s) => s.capture === 'empty')).toBe(true);
  // Expiry belongs to the original capture stream, never to completed archive evidence.
  expect(Date.parse(decoded.manifest.expiresAt)).toBeLessThan(Date.now());
});

test('unsupported versions, unfinished captures and inconsistent final counts are refused', () => {
  const file = archive();
  refuses({ ...file, manifest: { ...file.manifest, version: 2 } }, 'unsupported_version');
  refuses({ ...file, manifest: { ...file.manifest, format: 'other' } }, 'unsupported_version');
  refuses({ records: file.records }, 'incomplete_capture');
  refuses({ ...file, manifest: null }, 'incomplete_capture');
  refuses({ ...file, manifest: { ...file.manifest, rows: undefined } }, 'incomplete_capture');
  refuses({ ...file, manifest: { ...file.manifest, sections: file.manifest.sections.slice(1) } }, 'incomplete_capture');
  refuses({ ...file, manifest: { ...file.manifest, rows: 3 } }, 'inconsistent_manifest');
  refuses(
    { ...file, manifest: { ...file.manifest, recordBytes: file.manifest.recordBytes + 1 } },
    'inconsistent_manifest',
  );
  refuses({ ...file, manifest: { ...file.manifest, fullExport: true } }, 'invalid_envelope');
  refuses({ ...file, manifest: { ...file.manifest, state: 'collecting' } }, 'invalid_envelope');
});

test('duplicate native rows and names cannot select repeated effects or guess label equivalence', () => {
  refuses(archive([entry(first), entry(first)]), 'duplicate_record');
  refuses(archive([named(), named(randomUUID())]), 'duplicate_label');
  refuses(archive([named(), assignment(), assignment()]), 'duplicate_record');
  refuses(archive([assignment()]), 'incomplete_capture');
  const futureSection = { ...named(), section: 'future-section' } as unknown as ArchiveRecord;
  refuses(archive([entry(first), futureSection]), 'invalid_record');
  refuses(archive([named(), entry(first)]), 'invalid_record');
  expect(decode(archive([named(label, 'Weekend'), named(randomUUID(), 'weekend')])).records).toHaveLength(2);
});

test('native references and required shapes are validated without admitting stored authority', () => {
  refuses(archive([{ ...entry(first), subject_id_reference: reference(second) }]), 'invalid_record');
  refuses(archive([{ ...entry(first), revision: '7' }]), 'invalid_record');
  refuses(archive([{ ...entry(first), account_id: randomUUID() }]), 'invalid_record');
  refuses(archive([{ ...entry(first), requested_subject_id: second }]), 'invalid_record');
  const evidence = entry(first, 'unavailable-old-state');
  evidence.library_profile_pin = null;
  expect(decode(archive([evidence])).records[0]?.state).toBe('unavailable-old-state');
});

test('raw upload, nesting, rows and record bytes are bounded before native admission', () => {
  expect(() => decodeLibraryArchive(new Uint8Array(LIBRARY_ARCHIVE_LIMITS.uploadBytes + 1))).toThrow(
    new ArchiveValidationError('bounds'),
  );
  const nested = '['.repeat(LIBRARY_ARCHIVE_LIMITS.depth + 1) + '0' + ']'.repeat(LIBRARY_ARCHIVE_LIMITS.depth + 1);
  expect(() => decodeLibraryArchive(Buffer.from(nested))).toThrow(new ArchiveValidationError('bounds'));
  refuses(archive([{ ...entry(first), state: 'x'.repeat(LIBRARY_ARCHIVE_LIMITS.pageBytes) }]), 'bounds');
  const file = archive();
  refuses({ ...file, manifest: { ...file.manifest, rows: LIBRARY_ARCHIVE_LIMITS.records + 1 } }, 'bounds');
  refuses({ ...file, manifest: { ...file.manifest, recordBytes: LIBRARY_ARCHIVE_LIMITS.recordBytes + 1 } }, 'bounds');
});

test('malformed, duplicate-key and non-Unicode inputs never reflect private source text in errors', () => {
  for (const raw of ['{"private-name":', '{"manifest":null,"manife\\u0073t":null}', '"\\ud800"', '1e999']) {
    try {
      decodeLibraryArchive(Buffer.from(raw));
      throw new Error('Unexpected valid archive');
    } catch (error) {
      expect(error).toBeInstanceOf(ArchiveValidationError);
      expect((error as Error).message).not.toContain('private-name');
      expect((error as ArchiveValidationError).code).toBe('invalid_json');
    }
  }
  expect(() => decodeLibraryArchive(new Uint8Array([0xff]))).toThrow(new ArchiveValidationError('invalid_json'));
});
