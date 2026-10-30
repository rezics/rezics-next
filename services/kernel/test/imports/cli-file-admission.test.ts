import { expect, test } from 'bun:test';
import { runCliFileAdmissionJourney } from './cli-file-admission-fixture.ts';

test('Native file dump acquisition admission and baseline protection', async () => {
  const r = await runCliFileAdmissionJourney();
  try {
    expect(r.sources.map((s) => s.source).sort()).toEqual(['bangumi', 'openlibrary', 'vndb', 'wikidata']);
    for (const source of r.sources) {
      expect(source.initial.code).toBe(0);
      expect(source.initial.openHandles).toBe(0);
      expect(source.actualInputPasses).toBe(1);
      expect(source.nativeReceiptRows.length).toBeGreaterThan(0);
      for (const rejected of source.rejected) {
        expect(rejected.code).toBe(2);
        expect(rejected.openHandles).toBe(0);
        expect(rejected.authRequests).toEqual([]);
        expect(rejected.publicWrites).toEqual([]);
        expect(rejected.baselineAfter).toEqual(rejected.baselineBefore);
        expect(rejected.receiptRowsAfter).toEqual(rejected.receiptRowsBefore);
      }
      expect(source.rejected.length).toBeGreaterThanOrEqual(2);
      expect(source.acceptedSuccessor.code).toBe(0);
      expect(source.sourceKindAfter).toBe(source.source);
    }
    expect(r.userPostOrDumpSqlEffects).toEqual([]);
  } finally {
    await r.close();
  }
}, 1_800_000);
