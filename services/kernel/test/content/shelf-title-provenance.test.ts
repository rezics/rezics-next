import { expect, test } from 'bun:test';
import type { SemanticTitleProvenance, SemanticTitleProvenanceEntry } from '../../src/semantic/adapters/title-inputs-provenance.ts';
import { createContentShelfTitleProvenanceObserver } from '../../src/content/shelf-title-provenance.ts';
import { newId } from '../../src/route/route.ts';

const owner = { route: 0x6a10, accountId: newId(0x6a10) };
const viewer = {
  kind: 'account' as const,
  accountId: owner.accountId,
  clientId: newId(owner.route),
  requestedBy: null,
  authnEpoch: 1,
  scopes: ['library_entry:list'],
};
const originalId = newId(0x7b20);
const terminalId = newId(0x7c30);
const deadline = Date.now() + 60_000;

function binding(value: string, index: number) {
  return {
    value,
    origin: {
      kind: 'imported' as const,
      route: 0x3456,
      source: 'catalog',
      external_id: `record-${index}`,
      field_group: 'facts' as const,
    },
    support: { kind: 'term' as const, revision: 1, slot: `slot-${index}`, sequence: index },
  };
}

function entry(): SemanticTitleProvenanceEntry {
  const labels = Object.fromEntries(
    Array.from({ length: 101 }, (_, index) => [
      index === 0 ? 'en' : `en-x${index}`,
      binding(index === 1 ? '' : `Title ${index}`, index),
    ]),
  );
  return {
    subjectId: originalId,
    source: { subjectId: terminalId, identityEpoch: 'identity:1', terminalRevision: 2 },
    sourceBasis: 'identity:1:2',
    labels,
    originalLanguage: binding('en', 0),
  };
}

test('title provenance deduplicates and chunks exact fence tuples, withholding fenced labels and language', async () => {
  const row = entry();
  const provenance: SemanticTitleProvenance = {
    async observe(input) {
      expect(input.deadline).toBe(deadline);
      return { status: 'current', basis: 'semantic:1', entries: input.subjects.length ? [row] : [] };
    },
  };
  const batches: string[][] = [];
  const observer = createContentShelfTitleProvenanceObserver(provenance, async (tuples, observedDeadline) => {
    expect(observedDeadline).toBe(deadline);
    batches.push(tuples.map((tuple) => tuple.external_id));
    return tuples.map((tuple) => ({ ...tuple, takenDown: tuple.external_id === 'record-0', securityRevision: null }));
  });

  const result = await observer.observe({ owner, languages: ['en'], viewer, subjects: [originalId], deadline });
  expect(batches.map((batch) => batch.length)).toEqual([100, 1]);
  expect(new Set(batches.flat()).size).toBe(101);
  expect(result.status).toBe('current');
  if (result.status !== 'current') return;
  expect(result.entries[0]).toMatchObject({ subjectId: originalId, sourceId: terminalId, originalLanguage: null });
  expect(result.entries[0]?.labels).not.toHaveProperty('en');
  expect(result.entries[0]?.labels['en-x1']).toBe('');
  expect(Object.keys(result.entries[0]!.labels)).toHaveLength(100);
});

test('an incomplete source-fence batch is unavailable and a fresh complete observation recovers', async () => {
  const row = {
    subjectId: originalId,
    source: { subjectId: terminalId, identityEpoch: 'identity:1', terminalRevision: 2 },
    sourceBasis: 'identity:1:2',
    labels: { en: binding('Title', 0) },
    originalLanguage: null,
  } satisfies SemanticTitleProvenanceEntry;
  const provenance: SemanticTitleProvenance = {
    async observe(input) {
      return { status: 'current', basis: 'semantic:1', entries: input.subjects.length ? [row] : [] };
    },
  };
  let incomplete = true;
  const observer = createContentShelfTitleProvenanceObserver(provenance, async (tuples) =>
    incomplete ? [] : tuples.map((tuple) => ({ ...tuple, takenDown: false, securityRevision: null })),
  );
  const input = { owner, languages: ['en'], viewer, subjects: [originalId], deadline };
  expect(await observer.observe(input)).toEqual({ status: 'unavailable' });
  incomplete = false;
  expect((await observer.observe(input)).status).toBe('current');
});
