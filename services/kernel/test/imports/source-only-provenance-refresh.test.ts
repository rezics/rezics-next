import { expect, test } from 'bun:test';
import { runJourney } from './source-only-provenance-refresh-fixture.ts';

test('ordinary CLI refreshes changed source-only data through fresh native proposals without altering independent selection', async () => {
  const r = await runJourney();
  try {
    expect(r.initial.code).toBe(0);
    expect(r.changed.code).toBe(0);
    expect(r.changed.stdout).toContain('changed=1');
    expect(r.subjectAfter).toBe(r.subjectBefore);
    expect(r.digestAfter).not.toBe(r.digestBefore);
    expect(r.recordRevision).toBe('unversioned');
    expect(r.converterRevision).toBe('bangumi@3');
    expect(r.freshFacts).toHaveLength(2);
    expect(r.freshFacts.every((fact) => fact.digest === r.digestAfter)).toBe(true);
    expect(r.oldOwnedFacts.every((fact) => fact.retracted !== null)).toBe(true);
    expect(r.newDateSlots).toEqual([]);
    expect(r.originalReceiptsAfter).toEqual(r.originalReceiptsBefore);
    expect(r.bootstrapAfter).toEqual(r.bootstrapBefore);
    expect(r.independentSelectionAfter).toEqual(r.independentSelectionBefore);
    expect(r.unchanged.code).toBe(0);
    expect(r.unchangedWrites).toEqual([]);
    expect(r.fenced.code).toBe(0);
    expect(r.fencedFactWrites).toEqual([]);
    expect(r.disclosedFencedFacts).toEqual([]);
  } finally {
    await r.close();
  }
}, 1_800_000);
