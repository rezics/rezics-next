import { expect, test } from 'bun:test';
import type { IdentityMapping } from '../../src/semantic/contract/identity-values.ts';
import {
  bindSemanticTitleInputRows,
  createSemanticTitleInputsObserver,
  semanticTitleBasisVersion,
} from '../../src/semantic/title-inputs.ts';
import type { SemanticTitleInputEntry } from '../../src/semantic/contract/title-inputs.ts';
import { newId } from '../../src/route/route.ts';

type SourceRow = Parameters<typeof bindSemanticTitleInputRows>[2][number];
const original = newId(0x1200);
const terminal = newId(0x3400);
const entry: SemanticTitleInputEntry = {
  subjectId: original,
  sourceId: terminal,
  sourceBasis: '7:9',
  labels: { en: 'Current title' },
  originalLanguage: 'ja',
};
const mapping: IdentityMapping = { state: 'mapped', original, terminal, epoch: 7n };
const row = (id: string, values: Partial<SourceRow> = {}): SourceRow => ({
  id,
  labels: {},
  original: null,
  redirect: null,
  revision: '1',
  labelsComplete: true,
  ...values,
});
const basis = (version = 'whole-source-v2') => ({ version });

test('an unrequested Semantic title revision retires the basis while a Library-only position advance does not', () => {
  const homes = Array.from({ length: 4096 }, (_, partitionNo) => ({
    partitionNo,
    node: 'native',
    writeState: 'active' as const,
    movedTo: null,
    epoch: 1,
    titleRevision: '0',
    position: BigInt(partitionNo + 1),
  }));
  const release = { digest: `sha256:${'a'.repeat(64)}`, head: 4 };
  const before = semanticTitleBasisVersion(homes, release);
  const libraryPreparation = homes.map((home) => ({ ...home, position: home.position + 1n }));
  const changedElsewhere = homes.map((home) => (home.partitionNo === 3711 ? { ...home, titleRevision: '1' } : home));
  expect(before).toMatch(/^[0-9a-f]{64}$/);
  expect(semanticTitleBasisVersion(libraryPreparation, release)).toBe(before);
  expect(semanticTitleBasisVersion(changedElsewhere, release)).not.toBe(before);
  expect(semanticTitleBasisVersion(homes, { ...release, head: 5 })).not.toBe(before);
  expect(semanticTitleBasisVersion(homes.slice(1), release)).toBeNull();
});

test('a redirected original keeps its exact key and receives current terminal labels, language and source basis', () => {
  const sourceRows = [
    row(original, { redirect: terminal }),
    row(terminal, { labels: { en: 'Current title' }, original: 'ja', revision: '9' }),
  ];
  expect(bindSemanticTitleInputRows([original], [mapping], sourceRows)).toEqual([entry]);
});

test('empty input observes the same basis; missing and unsettled identity remain unavailable while empty labels stay current', async () => {
  let batches = 0;
  const observer = createSemanticTitleInputsObserver({
    readBasis: async () => basis(),
    readBatch: async () => {
      batches++;
      return null;
    },
    requireDeadline: () => {},
  });
  expect(await observer.observe({ subjects: [], deadline: Date.now() + 10_000 })).toEqual({
    status: 'current',
    basis: 'whole-source-v2',
    entries: [],
  });
  expect(batches).toBe(0);
  expect(await observer.observe({ subjects: [original], deadline: Date.now() + 10_000 })).toEqual({
    status: 'unavailable',
  });
  expect(
    bindSemanticTitleInputRows(
      [original],
      [{ state: 'pending', original, job: { jobId: newId(0), epoch: 8n } }],
      [row(original)],
    ),
  ).toBeNull();
  expect(
    bindSemanticTitleInputRows([original], [mapping], [row(original, { redirect: terminal }), row(terminal)]),
  ).toEqual([{ ...entry, labels: {}, originalLanguage: null, sourceBasis: '7:1' }]);
  expect(bindSemanticTitleInputRows([original], [mapping], [row(original, { redirect: terminal })])).toBeNull();
});

test('a second redirect or incomplete label map cannot be mistaken for a current terminal', () => {
  expect(
    bindSemanticTitleInputRows(
      [original],
      [mapping],
      [row(original, { redirect: terminal }), row(terminal, { redirect: newId(0x5600) })],
    ),
  ).toBeNull();
  expect(
    bindSemanticTitleInputRows(
      [original],
      [mapping],
      [row(original, { redirect: terminal }), row(terminal, { labelsComplete: false })],
    ),
  ).toBeNull();
});

test('a changed whole-source basis retires the batch; deadline expiry follows source snapshot cleanup', async () => {
  let reads = 0;
  const changed = createSemanticTitleInputsObserver({
    readBasis: async () => basis(reads++ === 0 ? 'before' : 'after'),
    readBatch: async () => [entry],
    requireDeadline: () => {},
  });
  expect(await changed.observe({ subjects: [original], deadline: Date.now() + 10_000 })).toEqual({
    status: 'unavailable',
  });

  let liveSnapshots = 0;
  let checks = 0;
  const expiring = createSemanticTitleInputsObserver({
    readBasis: async () => basis(),
    readBatch: async () => {
      liveSnapshots++;
      try {
        return [entry];
      } finally {
        liveSnapshots--;
      }
    },
    requireDeadline: () => {
      if (++checks === 3) throw new Error('deadline');
    },
  });
  await expect(expiring.observe({ subjects: [original], deadline: Date.now() + 10_000 })).rejects.toThrow('deadline');
  expect(liveSnapshots).toBe(0);
});
