import { expect, test } from 'bun:test';
import { runOpenLibraryDumpSetJourney } from './cli-openlibrary-dump-set.ts';

test('Open Library Work first publication date survives CLI refresh and explicit native selection', async () => {
  const result = await runOpenLibraryDumpSetJourney({ firstPublication: true });
  try {
    const publication = result.publication;
    expect(publication).toBeDefined();
    expect(publication!.workId).not.toBe(publication!.editionId);
    expect(publication!.firstCandidateId).not.toBe(publication!.refreshedCandidateId);
    expect(publication!.firstSelected.value).toEqual({
      type: 'value',
      content: { time: '+1853-00-00T00:00:00Z', precision: 9, calendarmodel: 'http://www.wikidata.org/entity/Q1985727' },
    });
    expect(publication!.refreshedSelected.value).toEqual({
      type: 'value',
      content: { time: '+1854-00-00T00:00:00Z', precision: 9, calendarmodel: 'http://www.wikidata.org/entity/Q1985727' },
    });
    expect(publication!.replayKey).toBeString();
    expect(JSON.parse(publication!.replayBytes).commands.length).toBeGreaterThan(0);
  } finally {
    await result.close();
  }
}, 1_800_000);
