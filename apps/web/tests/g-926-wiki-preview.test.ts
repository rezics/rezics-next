import { describe, expect, test } from 'bun:test';
import { languagesOf } from '../features/proposals/candidate.ts';
import { headerBefore, wikiBundleView, wikiDeltaView, wikiUndoView } from '../features/proposals/fixtures.ts';
import { wikiView } from '../features/proposals/wiki.ts';

const content = (view: ReturnType<typeof wikiView>) => {
  if (view?.kind !== 'content') throw new Error('expected a content preview');
  return view;
};

describe('G-926 wiki bundle preview', () => {
  test('a bundle reads as entities, claims, citations and positions, joined by name and unit label', () => {
    const view = content(wikiView(wikiBundleView.preview));
    expect(view.extractedBy).toBe('Assistant extraction agent');
    expect(view.entities.map(entity => [entity.name, entity.type, entity.existing])).toEqual([
      ['Elizabeth Bennet', 'Character', false], ['Jane Bennet', 'Character', true]]);
    expect(view.entities[0]!.names).toEqual([
      { value: 'Elizabeth Bennet', language: 'en', kind: 'primary', position: 'Chapter 1' },
      { value: 'Lizzy', language: 'en', kind: 'alias', position: 'Chapter 2' }]);
    expect(view.claims).toMatchObject([
      { subject: 'Elizabeth Bennet', object: { kind: 'literal', value: 'Bennet family' }, modality: 'narrated',
        position: 'Chapter 1', evidence: [{ quote: 'The Bennet family', locator: null, language: 'en' }] },
      { subject: 'Elizabeth Bennet', object: { kind: 'entity', name: 'Jane Bennet' }, modality: 'said',
        position: 'Chapter 3' }]);
    expect(view.corrections).toEqual([]);
  });

  test('a quotation rights withhold has no text, and no passage leaks through the locator', () => {
    const view = content(wikiView(wikiBundleView.preview));
    expect(view.claims[1]!.evidence.map(item => item.quote)).toEqual(['Elizabeth and Jane', null]);
    expect(JSON.stringify(view)).not.toContain('"exact"');
  });

  test('nothing a reviewer reads is an identifier, a path or a hash', () => {
    const readable = JSON.stringify([wikiView(wikiBundleView.preview), wikiView(wikiDeltaView.preview)]);
    expect(readable).not.toMatch(/https:\/\/rezics\.com\/id\/|[0-9a-f]{32}|representationSha256|claims › /);
  });

  test('a delta puts each correction beside the published claim it changes, and keeps citations out of the additions', () => {
    const view = content(wikiView(wikiDeltaView.preview));
    expect(view.claims).toEqual([]);
    expect(view.corrections).toMatchObject([
      { operation: 'amend', reason: 'Chapter four names the family differently',
        published: { object: { value: 'Bennet household' }, evidence: [{ quote: null }] },
        replacement: { object: { value: 'Bennet family' } }, citation: [] },
      { operation: 'retract', reason: 'The relation was a misreading',
        published: { object: { kind: 'entity', name: 'Jane Bennet' } }, replacement: null,
        citation: [{ quote: 'Elizabeth and Jane' }, { quote: null }] }]);
  });

  test('a reversal names the proposal it undoes', () => {
    expect(wikiView(wikiUndoView.preview)).toEqual({ kind: 'undo', of: 'bundle', proposal: expect.any(String) });
    expect(wikiView([{ path: 'delta', before: {}, after: { profile: 'wiki-delta-revert-v1', proposal: 'p' } }]))
      .toEqual({ kind: 'undo', of: 'delta', proposal: 'p' });
  });

  test('another kind of preview is not a wiki view', () => {
    expect(wikiView([{ path: 'localized', before: [], after: [] }])).toBeNull();
    expect(wikiView([])).toBeNull();
    expect(wikiView([{ path: 'delta', before: null, after: { profile: 'something-else' } }])).toBeNull();
  });
});

describe('G-926 correction languages', () => {
  test('a Work with no localized row still offers its own language', () => {
    const bare = { ...headerBefore, localized: [] };
    expect(languagesOf(bare)).toEqual(['zh-Hans']);
    expect(languagesOf(bare, 'sv')).toEqual(['zh-Hans', 'sv']);
    expect(languagesOf({ ...bare, originalTitle: null }, 'sv', undefined)).toEqual(['sv']);
  });

  test('localized languages come first and none repeats', () => {
    expect(languagesOf(headerBefore, 'zh-Hans', 'en')).toEqual(['en', 'zh-Hant', 'zh-Hans']);
  });
});
