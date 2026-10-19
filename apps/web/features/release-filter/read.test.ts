import { describe, expect, test } from 'bun:test';
import { direction } from '@rezics/main/language';
import { storyProfile } from '../profile/fixtures.ts';
import { realizations, releases } from '../work-levels/fixtures.ts';
import type { Loaded, Realization, Release } from '../work-levels/types.ts';
import { matchedRelease, realizationSelectionKey, type ReleaseHit } from './adapt.ts';
import { readRecords } from './read.ts';
import { noReleaseFilter } from './state.ts';

const iri = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
if (!realizations.ok || !releases.ok) throw new Error('Expected edition fixtures');
const first: Realization = { ...realizations.data.items[0]!, id: iri(1), revision: iri(11),
  language: 'en', translators: [iri(21)], evidence: iri(31) };
const corrected: Realization = { ...first, revision: iri(12), translators: [iri(22)], evidence: iri(32) };
const older: Release = { ...releases.data.items[0]!, id: iri(41), coverage: [{
  ...releases.data.items[0]!.coverage[0]!, work: first.work, realization: first.id,
  revision: first.revision, language: first.language,
}] };
const newer: Release = { ...older, id: iri(42), coverage: [{ ...older.coverage[0]!, revision: corrected.revision }] };
const hit: ReleaseHit = { id: first.work, title: { value: 'Work', language: 'en', direction: direction('en', 'Work'), basis: 'requested' },
  cover: null, matchedReleases: [older.id, newer.id], moreMatchedReleases: false };
const release = async (_work: string, id: string): Promise<Loaded<Release>> =>
  ({ ok: true, data: id === older.id.slice(-36) ? older : newer });

describe('release-filter selected realization reads', () => {
  test('read both actual pins once and derive each matched card from that pin', async () => {
    const requests: { work: string; identity: string; revision?: string }[] = [];
    const agents: string[] = [];
    const records = await readRecords([hit, hit], { release,
      realization: async (work, identity, revision) => {
        requests.push({ work, identity, revision });
        return { ok: true, data: revision === first.revision ? first : corrected };
      },
      agent: async id => {
        agents.push(id);
        return { ok: true, data: storyProfile({ displayName: id === iri(21).slice(-36) ? 'Translator A' : 'Translator B' }) };
      },
    });
    expect(requests).toEqual([first.revision, corrected.revision].map(revision => ({
      work: first.work.slice(-36), identity: first.id.slice(-36), revision,
    })));
    expect(agents.sort()).toEqual([iri(21).slice(-36), iri(22).slice(-36)]);
    expect(records.realizationReads?.get(realizationSelectionKey(first.id, first.revision))).toEqual({ ok: true, data: first });
    expect(records.realizationReads?.get(realizationSelectionKey(first.id, corrected.revision))).toEqual({ ok: true, data: corrected });
    expect(matchedRelease(older, hit.id, noReleaseFilter, records).translators.map(name => name.value)).toEqual(['Translator A']);
    expect(matchedRelease(newer, hit.id, noReleaseFilter, records).translators.map(name => name.value)).toEqual(['Translator B']);
  });

  test('missing, denied and unavailable exact pins retain their typed refusal without a head retry or name read', async () => {
    for (const [status, failure] of [[404, 'missing'], [403, 'identity'], [503, 'unavailable']] as const) {
      const requested: (string | undefined)[] = [];
      const refused: Loaded<Realization> = { ok: false, failure, status, problem: { error: 'selected_revision' } };
      const records = await readRecords([{ ...hit, matchedReleases: [older.id] }], { release,
        realization: async (_work, _identity, revision) => { requested.push(revision); return refused; },
        agent: async () => { throw new Error('A refused pin cannot authorize a translator name lookup'); },
      });
      expect(requested).toEqual([first.revision]);
      expect(records.realizationReads?.get(realizationSelectionKey(first.id, first.revision))).toEqual(refused);
      expect(records.realizations.has(first.id)).toBe(false);
      expect(matchedRelease(older, hit.id, noReleaseFilter, records).translators).toEqual([]);
    }
  });

  test('a refused translator profile does not synthesize a name', async () => {
    const records = await readRecords([{ ...hit, matchedReleases: [older.id] }], { release,
      realization: async () => ({ ok: true, data: first }), agent: async () => ({ ok: false, failure: 'missing', status: 403 }),
    });
    expect(records.translators.size).toBe(0);
    expect(matchedRelease(older, hit.id, noReleaseFilter, records).translators).toEqual([]);
  });
});
