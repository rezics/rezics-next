import { expect, test } from 'bun:test';
import { runOpenLibraryEditionMediaJourney } from './openlibrary-cli-edition-media-fixture.ts';

test('Open Library work edition and cover operator lifecycle', async () => {
  const r = await runOpenLibraryEditionMediaJourney();
  try {
    expect(r.initial.code).toBe(0);
    expect(r.workImport.code).toBe(0);
    expect(r.learnedRefresh.code).toBe(0);
    expect(r.workId).not.toBe(r.editionId);
    expect(r.editionType).toBe('bf:Instance');
    expect(r.resolvedWorkRelation).toBe(r.workId);
    expect(r.foreignWorkId).not.toBe(r.resolvedWorkRelation);
    expect(r.unresolvedAuthorCitation).toContain('/authors/');
    expect(r.isbnValues.length).toBeGreaterThan(0);
    expect(r.languageValues.length).toBeGreaterThan(0);
    expect(r.unknownProseOccurrences).toEqual([]);
    expect(r.availableCovers.length).toBeGreaterThan(0);
    for (const media of r.availableCovers) {
      expect(media.row.state).toBe('available');
      expect(media.row.purpose).toBe('cover');
      expect(media.row.credit.rightsHolder).toContain('rights holder');
      expect(media.variants.length).toBeGreaterThan(0);
    }
    expect(r.unavailableSentinelRequests).toEqual([]);
    expect(r.fencedReopen.code).toBe(0);
    expect(r.disclosedCoversAfterFence).toEqual([]);
    expect(r.nativeEntryRevisionAfter).toBe(r.nativeEntryRevisionBefore);
    expect(r.originalBootstrapAfter).toEqual(r.originalBootstrapBefore);
  } finally {
    await r.close();
  }
}, 1_800_000);
