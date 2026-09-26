import { expect, test } from 'bun:test';
import { sourceAcquisitionServices } from '../../../services/main/src/modules/source/acquisition.ts';
import { compareVndbConceptRuns, readVndbConceptRun } from
  '../../../services/main/src/modules/source/vndb-concept-run.ts';
import { sameCharacterTraitAppearance, survivingVndbClaims } from
  '../../../services/main/src/modules/source/field-vndb.ts';
import { captureVndbFixtureRun, vndbConceptBodies } from '../fixtures/vndb-concept.ts';
import { runHarness } from './source-run-harness.ts';

test('LIVE01/LIVE09: VNDB dispositions compare every frozen field and a mid-run source change waits for the next run',
  async () => {
    const h = await runHarness();
    try {
      const services = sourceAcquisitionServices(h.contentPool, { fetcher: h.provider.fetch, reserve: async () => {} });
      const firstBodies = vndbConceptBodies('base');
      const candidateBodies = vndbConceptBodies('candidate');
      const base = await captureVndbFixtureRun(services.runs, h.ownerId, 'vndb-base', firstBodies, {
        afterCapture: surface => { if (surface === 'vn') firstBodies.set('vn', candidateBodies.get('vn')!); },
      });
      expect(base.state).toBe('completed');
      const frozen = await readVndbConceptRun(services.runs, h.ownerId, base.run.split('/').at(-1)!);
      expect(frozen.work.captures).toBe(4);
      expect(frozen.work.bytes).toBeLessThanOrEqual(4 * 65_536);
      expect(frozen.work.fields).toBeLessThanOrEqual(4 * 256);
      expect(frozen.work.concepts).toBeLessThanOrEqual(200);
      expect(frozen.work.claims).toBeLessThanOrEqual(30_000);
      expect(frozen.projection.claims.find(claim => claim.kind === 'tag' && claim.concept === 'vndb:tag:g1')?.score)
        .toBe(2.5);
      expect(frozen.projection.fieldInventory).toContainEqual(expect.objectContaining({ grain: 'vn',
        field: 'legacy_note', disposition: 'unsupported', reason: 'undeclared-field' }));
      expect(frozen.captures.find(capture => capture.surface === 'vn')?.bytes.toString()).toContain('"rating":2.500');
      const conjunction = sameCharacterTraitAppearance(frozen.projection.claims, 'vndb:character:c1',
        'vndb:trait:i1', 'vndb:release:r1');
      expect(conjunction).not.toBeNull();
      const withoutTraitSupport = survivingVndbClaims(frozen.projection.claims, new Set([conjunction!.trait]));
      expect(sameCharacterTraitAppearance(withoutTraitSupport, 'vndb:character:c1',
        'vndb:trait:i1', 'vndb:release:r1')).toBeNull();
      expect(withoutTraitSupport.filter(claim => claim.kind === 'appearance' && claim.subject === 'vndb:character:c1'))
        .toHaveLength(2);

      // A new run sees the changed provider response; the first run and its exact bytes stay immutable.
      const next = await captureVndbFixtureRun(services.runs, h.ownerId, 'vndb-next', candidateBodies);
      const current = await readVndbConceptRun(services.runs, h.ownerId, next.run.split('/').at(-1)!);
      const drift = compareVndbConceptRuns(frozen, current);
      expect(drift).toEqual(expect.arrayContaining([
        expect.objectContaining({ grain: 'vn', field: 'legacy_note', status: 'removed', disposition: 'unsupported' }),
        expect.objectContaining({ grain: 'vn', field: 'future_field', status: 'added', disposition: 'unsupported' }),
        expect.objectContaining({ grain: 'vn', field: 'tags', status: 'changed' }),
        expect.objectContaining({ grain: 'tag', field: 'description', status: 'changed',
          disposition: 'structured-source-only' }),
      ]));
      expect((await readVndbConceptRun(services.runs, h.ownerId, frozen.run.split('/').at(-1)!)).captures
        .find(capture => capture.surface === 'vn')?.digest).toBe(frozen.captures[0]?.digest);
      const replay = await captureVndbFixtureRun(services.runs, h.ownerId, 'vndb-base', firstBodies);
      expect(replay.run).toBe(base.run);
      expect(replay.surfaces.flatMap(surface => surface.captures)).toHaveLength(4);
    } finally { await h.close(); }
  }, 60_000);

test('LIVE11: a VNDB concept surface behind provider access is unqualified and cannot become guessed data', async () => {
  const h = await runHarness();
  try {
    const services = sourceAcquisitionServices(h.contentPool, { fetcher: h.provider.fetch, reserve: async () => {} });
    const run = await captureVndbFixtureRun(services.runs, h.ownerId, 'vndb-denied', vndbConceptBodies(), {
      unqualifiedSurface: 'trait',
    });
    expect(run.state).toBe('incomplete');
    expect(run.completion).toMatchObject({ outcome: 'incomplete', unqualified: 1 });
    const trait = run.surfaces.find(surface => surface.surface === 'trait')!;
    expect(trait.outcome).toMatchObject({ outcome: 'unqualified', reason: 'authorization-denied', captureCount: 0 });
    expect(trait.captures).toEqual([]);
    await expect(readVndbConceptRun(services.runs, h.ownerId, run.run.split('/').at(-1)!)).rejects.toThrow();
  } finally { await h.close(); }
}, 60_000);
