import { expect, test } from 'bun:test';
import { composeContentShelfTitleInputs } from '../../src/library/shelf-title-inputs-composition.ts';
import { createContentShelfTitleSource } from '../../src/library/shelf-title-content-source.ts';
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
const redirectedId = newId(0x7c30);

test('the composed adapter preserves exact originals, authorizes redirects and keeps visible empty labels', async () => {
  const accessBatches: string[][] = [];
  let allowRedirect = true;
  const source = createContentShelfTitleSource(
    composeContentShelfTitleInputs(
      {
        async observe(input) {
          return {
            status: 'current',
            version: 'titles:1',
            entries: input.subjects.length
              ? [
                  {
                    subjectId: originalId,
                    sourceId: redirectedId,
                    sourceBasis: 'owner:1',
                    labels: {},
                    originalLanguage: null,
                  },
                ]
              : [],
          };
        },
      },
      {
        readVersion: async () => ({ status: 'current', version: 'access:1' }),
        async decide(input) {
          accessBatches.push([...input.subjects]);
          return {
            status: 'current',
            version: 'access:1',
            decisions: input.subjects.map((subjectId) => ({
              subjectId,
              allowed: allowRedirect || subjectId !== redirectedId,
            })),
          };
        },
      },
    ),
  );
  const basis = await source.basis(owner, ['en'], viewer);
  if (basis.status !== 'current') throw new Error('Expected complete basis');
  const result = await source.labels(owner, ['en'], basis.version, [originalId], viewer);
  if (result.status !== 'current') throw new Error('Expected disclosed title');
  expect(accessBatches).toEqual([[originalId, redirectedId]]);
  expect(result.entries).toEqual([
    {
      subjectId: originalId,
      sourceId: redirectedId,
      sourceBasis: 'owner:1',
      labels: {},
      originalLanguage: null,
    },
  ]);

  allowRedirect = false;
  expect(await source.labels(owner, ['en'], basis.version, [originalId], viewer)).toEqual({ status: 'unavailable' });
});

test('unrequested source and disclosure changes retire the complete observation', async () => {
  for (const change of ['title', 'disclosure'] as const) {
    let titleVersion = 'titles:1';
    let accessVersion = 'access:1';
    let emptyReads = 0;
    let accessVersionReads = 0;
    const source = createContentShelfTitleSource(
      composeContentShelfTitleInputs(
        {
          async observe(input) {
            if (!input.subjects.length && ++emptyReads === 3 && change === 'title') titleVersion = 'titles:2';
            return {
              status: 'current',
              version: titleVersion,
              entries: input.subjects.length
                ? [{ subjectId: originalId, sourceId: originalId, sourceBasis: 'owner:1', labels: { en: 'Name' } }]
                : [],
            };
          },
        },
        {
          async readVersion() {
            if (++accessVersionReads === 4 && change === 'disclosure') accessVersion = 'access:2';
            return { status: 'current', version: accessVersion };
          },
          async decide(input) {
            return {
              status: 'current',
              version: accessVersion,
              decisions: input.subjects.map((subjectId) => ({ subjectId, allowed: true })),
            };
          },
        },
      ),
    );
    const basis = await source.basis(owner, ['en'], viewer);
    if (basis.status !== 'current') throw new Error('Expected initial basis');
    expect(await source.labels(owner, ['en'], basis.version, [originalId], viewer)).toEqual({ status: 'unavailable' });
  }
});

test('a mid-observation revoke fails closed and a fresh stable four-batch observation recovers', async () => {
  const originals = Array.from({ length: 100 }, () => newId(0x7b20));
  const resolved = originals.map(() => newId(0x7c30));
  let accessVersion = 'access:1';
  let revokeAfterFirstBatch = true;
  const batches: string[][] = [];
  const source = createContentShelfTitleSource(
    composeContentShelfTitleInputs(
      {
        async observe(input) {
          return {
            status: 'current',
            version: 'titles:1',
            entries: input.subjects.map((subjectId) => {
              const index = originals.indexOf(subjectId);
              return {
                subjectId,
                sourceId: resolved[index]!,
                sourceBasis: 'owner:1',
                labels: { en: 'Name' },
              };
            }),
          };
        },
      },
      {
        readVersion: async () => ({ status: 'current', version: accessVersion }),
        async decide(input) {
          const observedVersion = accessVersion;
          batches.push([...input.subjects]);
          if (revokeAfterFirstBatch && batches.length === 1) accessVersion = 'access:2';
          return {
            status: 'current',
            version: observedVersion,
            decisions: input.subjects.map((subjectId) => ({ subjectId, allowed: true })),
          };
        },
      },
    ),
  );
  const initial = await source.basis(owner, ['en'], viewer);
  if (initial.status !== 'current') throw new Error('Expected initial basis');
  expect(await source.labels(owner, ['en'], initial.version, originals, viewer)).toEqual({ status: 'unavailable' });
  expect(batches.slice(0, 2).map((batch) => batch.length)).toEqual([64, 64]);

  revokeAfterFirstBatch = false;
  const fresh = await source.basis(owner, ['en'], viewer);
  if (fresh.status !== 'current') throw new Error('Expected fresh authorized basis');
  const recovered = await source.labels(owner, ['en'], fresh.version, originals, viewer);
  if (recovered.status !== 'current') throw new Error('Expected stable authorized batch');
  expect(batches.slice(2).map((batch) => batch.length)).toEqual([64, 64, 64, 8]);
  expect(recovered.entries.map((row) => row.subjectId)).toEqual(originals);
  expect(recovered.entries.map((row) => row.sourceId)).toEqual(resolved);
});

test('a failed current Access observation retires the whole batch without exposing title labels', async () => {
  const source = createContentShelfTitleSource(
    composeContentShelfTitleInputs(
      {
        async observe(input) {
          return {
            status: 'current',
            version: 'titles:1',
            entries: input.subjects.length
              ? [{ subjectId: originalId, sourceId: originalId, sourceBasis: 'owner:1', labels: { en: 'Private' } }]
              : [],
          };
        },
      },
      {
        readVersion: async () => ({ status: 'current', version: 'access:1' }),
        decide: async () => {
          throw new Error('Access source failed');
        },
      },
    ),
  );
  const basis = await source.basis(owner, ['en'], viewer);
  if (basis.status !== 'current') throw new Error('Expected basis');
  expect(await source.labels(owner, ['en'], basis.version, [originalId], viewer)).toEqual({ status: 'unavailable' });
});
