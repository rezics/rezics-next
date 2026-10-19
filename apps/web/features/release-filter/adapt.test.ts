import { describe, expect, test } from 'bun:test';
import { direction } from '@rezics/main/language';
import { realizations, releases } from '../work-levels/fixtures.ts';
import type { Realization, Release } from '../work-levels/types.ts';
import { matchedRelease, realizationSelectionKey, type ReleaseRecords } from './adapt.ts';
import { noReleaseFilter } from './state.ts';

const iri = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
if (!realizations.ok || !releases.ok) throw new Error('Expected edition fixtures');
const first: Realization = { ...realizations.data.items[0]!, id: iri(1), revision: iri(11),
  language: 'en', translators: [iri(21)], evidence: iri(31) };
const corrected: Realization = { ...first, revision: iri(12), translators: [iri(22)], evidence: iri(32) };
const release: Release = { ...releases.data.items[0]!, id: iri(41), coverage: [{
  ...releases.data.items[0]!.coverage[0]!, work: first.work, realization: first.id,
  revision: first.revision, language: first.language,
}] };
const name = (value: string) => ({ value, lang: 'en', dir: direction('en', value) });
const records: ReleaseRecords = { releases: new Map(), realizations: new Map([[first.id, corrected]]), realizationReads: new Map([
  [realizationSelectionKey(first.id, first.revision), { ok: true, data: first }],
  [realizationSelectionKey(corrected.id, corrected.revision), { ok: true, data: corrected }],
]), translators: new Map([[iri(21), name('Translator A')], [iri(22), name('Translator B')]]) };

describe('release-filter exact coverage attribution', () => {
  test('two releases selecting different revisions keep their own translator and evidence selection', () => {
    const newer: Release = { ...release, id: iri(42), coverage: [{ ...release.coverage[0]!, revision: corrected.revision }] };
    expect(matchedRelease(release, first.work, noReleaseFilter, records).translators).toEqual([name('Translator A')]);
    expect(matchedRelease(newer, first.work, noReleaseFilter, records).translators).toEqual([name('Translator B')]);
  });

  test('an absent or refused pin never falls back to a readable current head', () => {
    for (const refusal of [undefined, 'missing', 'identity', 'unavailable'] as const) {
      const reads = new Map(records.realizationReads);
      reads.delete(realizationSelectionKey(first.id, first.revision));
      reads.set(realizationSelectionKey(first.id, null), { ok: true, data: corrected });
      if (refusal) reads.set(realizationSelectionKey(first.id, first.revision), { ok: false, failure: refusal });
      expect(matchedRelease(release, first.work, noReleaseFilter, { ...records, realizationReads: reads }).translators).toEqual([]);
    }
  });

  test('existing supplied records require a matching revision when coverage pins one', () => {
    const supplied: ReleaseRecords = { releases: records.releases, translators: records.translators,
      realizations: new Map([[first.id, first]]) };
    expect(matchedRelease(release, first.work, noReleaseFilter, supplied).translators).toEqual([name('Translator A')]);
    expect(matchedRelease(release, first.work, noReleaseFilter,
      { ...supplied, realizations: records.realizations }).translators).toEqual([]);
    const unpinned: Release = { ...release, coverage: [{ ...release.coverage[0]!, revision: null }] };
    expect(matchedRelease(unpinned, first.work, noReleaseFilter,
      { ...supplied, realizations: records.realizations }).translators).toEqual([name('Translator B')]);
  });

  test('an Agent not named by the public profile read remains unnamed', () => {
    expect(matchedRelease(release, first.work, noReleaseFilter, { ...records, translators: new Map() }).translators).toEqual([]);
  });
});
