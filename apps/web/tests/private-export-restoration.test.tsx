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
