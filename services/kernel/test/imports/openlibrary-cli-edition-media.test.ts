import { expect, test } from 'bun:test';
import { runOpenLibraryEditionMediaJourney } from './openlibrary-cli-edition-media-fixture.ts';

test('Open Library edition pages, work relations and cover operator lifecycle', async () => {
  const r = await runOpenLibraryEditionMediaJourney();
  try {
    expect(r.initial.code).toBe(0);
    expect(r.workImport.code).toBe(0);
    expect(r.learnedRefresh.code).toBe(0);
    expect(r.pageImport.code).toBe(0);
    expect(r.pageResolve.code).toBe(0);
    expect(r.lostRefresh.code).not.toBe(0);
    expect(r.reopenedRefresh.code).toBe(0);
    expect(r.fencedPageRefresh.code).toBe(0);
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
    expect(r.pageEditionId).not.toBe(r.pageWorkId);
    expect(r.pageEditionType).toBe('bf:Instance');
    expect(r.pageWorkType).toBe('schema:Book');
    expect(r.pageWorkRelation).toBe(r.pageWorkId);
    expect(r.pageCountBeforeRefresh).toEqual({ amount: '+96', unit: '1' });
    expect(r.pageCountAfterProposal).toEqual({ amount: '+96', unit: '1' });
    expect(r.pageCountAfterRefreshSelection).toEqual({ amount: '+104', unit: '1' });
    expect(r.pageCountAfterFactsFence).toEqual({ amount: '+104', unit: '1' });
    expect(r.factsFenceRejected120).toBe(true);
    expect(r.pageBootstrapAfter).toEqual(r.pageBootstrapBefore);
    expect(r.pageProposal96After).toEqual(r.pageProposal96Before);
    expect(r.pageProposal104After).toEqual(r.pageProposal104BeforeFence);
  } finally {
    await r.close();
  }
}, 1_800_000);
