import { afterEach, expect, test } from 'bun:test';
import { artifactFilename } from '../src/library/private-export/contract';
import {
  archiveBase64FromCustody,
  archiveFileFromCustody,
  archiveTextFromCustody,
  bindArchiveCustodyOwner,
  completedArchiveFor,
  holdCompletedArchive,
  releaseCompletedArchive,
} from '../src/library/private-export/custody';
import {
  projectArchiveForRecovery,
  supportedRecoveryVersion,
} from '../src/library/private-export/supported-recovery-artifact';
import {
  EXPORT_FORMAT,
  EXPORT_SECTIONS_V1,
  EXPORT_SECTIONS_V3,
  EXPORT_SECTIONS_V4,
  EXPORT_V4_COVERAGE,
  encodedRecordBytes,
} from '../src/library/private-export/contract';
import { libraryNavigation } from '../src/library/navigation';

const owner = 'owner-a';
const other = 'owner-b';
const bytes = new TextEncoder().encode('{"manifest":{"version":1},"records":[]}');

afterEach(() => {
  releaseCompletedArchive(owner);
  releaseCompletedArchive(other);
});

test('a completed export stays with its owner and another account cannot inherit it', () => {
  holdCompletedArchive(
    owner,
    { filename: artifactFilename('00000000-0000-4000-8000-000000000001'), mediaType: 'application/json', bytes },
    {
      exportId: '00000000-0000-4000-8000-000000000001',
      capturedAt: '2026-11-06T00:00:00.000Z',
      version: 1,
    },
  );
  bindArchiveCustodyOwner(other);
  expect(completedArchiveFor(owner)).toBeNull();
  expect(completedArchiveFor(other)).toBeNull();

  holdCompletedArchive(
    owner,
    { filename: 'library.json', mediaType: 'application/json', bytes },
    {
      exportId: '00000000-0000-4000-8000-000000000002',
      capturedAt: '2026-11-06T00:00:00.000Z',
      version: 1,
    },
  );
  const held = completedArchiveFor(owner)!;
  expect(archiveTextFromCustody(held)).toContain('"records"');
  expect(archiveBase64FromCustody(held)).toBe(btoa(String.fromCharCode(...bytes)));
  expect(archiveFileFromCustody(held).name).toBe('library.json');
  bindArchiveCustodyOwner(other);
  expect(completedArchiveFor(owner)).toBeNull();
});

test('Library navigation lists export and the three archive recovery visits', () => {
  const hrefs = libraryNavigation.map((item) => item.href);
  expect(hrefs).toContain('/library/export');
  expect(hrefs).toContain('/library/recover-collections');
  expect(hrefs).toContain('/library/recover-archive');
  expect(hrefs).toContain('/library/recover-progress');
  expect(libraryNavigation.find((item) => item.href === '/library/recover-progress')).toMatchObject({
    signedIn: true,
    match: 'exact',
    group: 'personal',
  });
});

test('a completed V4 export projects to installed Collection V1 and Entry/progress V3 envelopes', () => {
  const exportId = '00000000-0000-4000-8000-00000000000a';
  const capturedAt = '2026-11-06T00:00:00.000Z';
  const expiresAt = '2026-11-06T00:15:00.000Z';
  const entries = { section: 'entries' as const, subject_id: exportId };
  const provider = { section: 'vndbEvidence' as const, ordinal: 0 };
  const records = [entries, provider];
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      manifest: {
        format: EXPORT_FORMAT,
        version: 4,
        coverage: EXPORT_V4_COVERAGE,
        exportId,
        capturedAt,
        expiresAt,
        privacy: 'private',
        completeness: 'supported-native-facts',
        sections: [...EXPORT_SECTIONS_V4],
        omissions: {
          trash: 'x',
          providerIdentifiers: 'x',
          personalImportEvidence: 'x',
          commerce: 'x',
          publication: 'x',
          reimport: 'x',
        },
        fullExport: false,
        rows: 2,
        recordBytes: encodedRecordBytes(entries) + encodedRecordBytes(provider),
      },
      records,
    }),
  );
  expect(supportedRecoveryVersion('collections', 4)).toBe(1);
  expect(supportedRecoveryVersion('entries', 4)).toBe(3);
  expect(supportedRecoveryVersion('progress', 2)).toBe(2);
  const collection = JSON.parse(new TextDecoder().decode(projectArchiveForRecovery(bytes, 'collections'))) as {
    manifest: { version: number; sections: string[]; rows: number; recordBytes: number };
    records: { section: string }[];
  };
  expect(collection.manifest.version).toBe(1);
  expect(collection.manifest.sections).toEqual([...EXPORT_SECTIONS_V1]);
  expect(collection.records.map((row) => row.section)).toEqual(['entries']);
  expect(collection.manifest.rows).toBe(1);
  expect(collection.manifest.recordBytes).toBe(encodedRecordBytes(entries));
  const restored = JSON.parse(new TextDecoder().decode(projectArchiveForRecovery(bytes, 'entries'))) as {
    manifest: { version: number; sections: string[]; coverage: string };
    records: { section: string }[];
  };
  expect(restored.manifest.version).toBe(3);
  expect(restored.manifest.sections).toEqual([...EXPORT_SECTIONS_V3]);
  expect(restored.records.some((row) => row.section === 'vndbEvidence')).toBe(false);
  const progress = JSON.parse(new TextDecoder().decode(projectArchiveForRecovery(bytes, 'progress'))) as {
    manifest: { version: number; coverage: string };
  };
  expect(progress.manifest.version).toBe(3);
  expect(progress.manifest.coverage).toBe(restored.manifest.coverage);
  const already = projectArchiveForRecovery(bytes, 'collections');
  expect(projectArchiveForRecovery(already, 'collections')).toEqual(already);
  expect(new TextDecoder().decode(bytes)).toContain('"version":4');
});
