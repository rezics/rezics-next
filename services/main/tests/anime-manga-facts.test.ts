import { expect, test } from 'bun:test';
import captured from './bangumi-captured-subjects.json';
import { vocabularyDigest } from '../src/modules/classification/vocabulary.ts';
import { checkedComponentState } from '../src/modules/semantic/change.ts';
import { checkedMetadataState, InvalidWorkMetadata, serialStatuses, type SerialStatus }
  from '../src/modules/work/metadata-schema.ts';
import { declaredCountProperties, workFormatConcepts, type WorkFormatKey }
  from '../../../scripts/dev/seed/relation-lexicon-data.ts';
import { admitWorkFormat, bangumiWorkFacts, type BangumiFactSource }
  from '../../../scripts/datasets/bangumi.ts';

const actor = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const subjects = captured as Record<string, BangumiFactSource>;

test('format concepts and declared counts are definitions the vocabulary accepts', () => {
  for (const concept of workFormatConcepts) {
    expect(vocabularyDigest({ actingSubject: actor, scheme: null, labels: [...concept.labels],
      alternativeLabels: [], broader: [], narrower: [] })).toMatch(/^[0-9a-f]{64}$/);
  }
  for (const property of declaredCountProperties) {
    expect(checkedComponentState({ component: 'definition', kind: 'property',
      notation: property.notation, roles: [] })).toMatchObject({
      component: 'definition', kind: 'property', notation: property.notation, roles: [],
    });
  }
});

test('a Work admits one known format and refuses an unknown one', () => {
  expect(admitWorkFormat(null, null)).toBeNull();
  expect(admitWorkFormat(null, 'tv')).toBe('tv');
  expect(admitWorkFormat('tv', 'tv')).toBe('tv');
  expect(admitWorkFormat('tv', null)).toBe('tv');
  expect(() => admitWorkFormat(null, 'novel')).toThrow('unknown work format');
  expect(() => admitWorkFormat('tv', 'movie')).toThrow('a Work admits one format');
});

test('completion accepts upcoming and cancelled beside the original three', () => {
  for (const completionStatus of serialStatuses) {
    expect(checkedMetadataState({ kind: 'header', originalTitle: null, completionStatus, localized: [] }))
      .toMatchObject({ kind: 'header', completionStatus });
  }
  expect(() => checkedMetadataState({ kind: 'header', originalTitle: null,
    completionStatus: 'unknown', localized: [] })).toThrow(InvalidWorkMetadata);
});

test('Bangumi import maps captured subjects onto the format scheme', () => {
  // The capture contains TV, movie, OVA, ONA and manga. Special (anime platform 4)
  // and one-shot have no captured subject, so they are not invented here.
  const expected: Record<string, { format: WorkFormatKey | null; count: string | null;
    status: SerialStatus | null }> = {
    '975': { format: 'tv', count: 'episode-count:1155', status: null },
    '1867': { format: 'ova', count: 'episode-count:1', status: null },
    '1869': { format: 'movie', count: 'episode-count:1', status: null },
    '310194': { format: 'ona', count: 'episode-count:25', status: null },
    '3582': { format: 'manga', count: 'volume-count:21', status: 'completed' },
    '3510': { format: 'manga', count: null, status: 'ongoing' },
    '397781': { format: null, count: null, status: null },
    '20700': { format: null, count: null, status: null },
  };
  for (const [id, want] of Object.entries(expected)) {
    const facts = bangumiWorkFacts(subjects[id]!);
    expect({ format: facts.format, count: facts.count ? `${facts.count.notation}:${facts.count.lexical}` : null,
      status: facts.status }, id).toEqual(want);
  }
  const disagreeing = { ...subjects['975']!, api_subject: { type: 2, platform: '剧场版' } };
  expect(() => bangumiWorkFacts(disagreeing)).toThrow('disagree on format');
});
