import { expect, test } from 'bun:test';
import { converter_revision } from '../../../../packages/conversion/src/wikidata.ts';
import { runWikidataRichCliJourney } from './wikidata-rich-cli-fixture.ts';

test('Wikidata rich cited proposal CLI refresh', async () => {
  const r = await runWikidataRichCliJourney();
  try {
    expect(r.initial.code).toBe(0);
    expect(r.converterRevision).toBe(converter_revision);
    expect(r.richCitedCandidates.length).toBeGreaterThan(0);
    for (const candidate of r.richCitedCandidates) expect(candidate.references.length).toBeGreaterThan(0);
    expect(r.selectedSupportedValues).toEqual(r.nativeSupportedValues);
    expect(r.withheldExactMeasurementCandidates).toEqual([]);
    expect(r.unknownLanguageTextDisclosures).toEqual([]);
    expect(r.unknownProseOrImageEffects).toEqual([]);
    expect(r.refreshed.code).toBe(0);
    expect(r.refreshedSubjectId).toBe(r.initialSubjectId);
    expect(r.newSupportedProposalIds.length).toBeGreaterThan(0);
    expect(r.independentSelectionAfter).toEqual(r.independentSelectionBefore);
    expect(r.unchangedReopen.code).toBe(0);
    expect(r.unchangedReopenWrites).toEqual([]);
    expect(r.originalBootstrapAfter).toEqual(r.originalBootstrapBefore);
    expect(r.fencedRefresh.code).toBe(0);
    expect(r.disclosedFencedFacts).toEqual([]);
    expect(r.nativeReceiptRows.length).toBeGreaterThan(0);
  } finally {
    await r.close();
  }
}, 1_800_000);
