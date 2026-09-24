import { expect, test } from 'bun:test';
import { effectiveText, expectedPublicPhraseRows, type WorkPublication }
  from '../oracles/public-selection.ts';

test('WORK03/SEARCH19: partial pure Main and Realm choice oracle distinguishes absence, rejection and unavailable', () => {
  const main = { selection: 's-main', matchUnit: 'u-main', contribution: 'c-main',
    revision: 'r-main', language: 'en', body: 'cedar beacon', author: 'author-a' };
  const local = { selection: 's-local', matchUnit: 'u-local', contribution: 'c-local',
    revision: 'r-local', language: 'zh', body: 'cedar beacon', author: 'author-b' };
  const realm = { kind: 'realm' as const, id: 'realm-a' };
  const otherRealm = { kind: 'realm' as const, id: 'realm-b' };
  const work: WorkPublication = { work: 'work', mainVersion: 'main', main, local: {} };
  expect(effectiveText(work, realm)).toEqual({ text: main, reason: 'main-fallback' });
  expect(expectedPublicPhraseRows([work], realm, 'cedar', 'en')).toMatchObject([
    { selection: 's-main', reason: 'main-fallback' },
  ]);
  work.local = { [realm.id]: { kind: 'adopted', text: local } };
  expect(expectedPublicPhraseRows([work], { kind: 'main' }, 'cedar', 'en')).toMatchObject([
    { selection: 's-main' },
  ]);
  expect(expectedPublicPhraseRows([work], realm, 'cedar', 'en')).toEqual([]);
  expect(expectedPublicPhraseRows([work], realm, 'cedar', 'zh')).toMatchObject([
    { selection: 's-local', reason: 'realm-adoption' },
  ]);
  expect(expectedPublicPhraseRows([work], realm, 'cedar', 'zh', 'author-a')).toEqual([]);
  expect(expectedPublicPhraseRows([work], realm, 'cedar', 'zh', 'author-b')).toHaveLength(1);
  expect(expectedPublicPhraseRows([work], otherRealm, 'cedar', 'en')).toMatchObject([
    { selection: 's-main', reason: 'main-fallback' },
  ]);
  work.local = { [realm.id]: { kind: 'rejected' } };
  expect(expectedPublicPhraseRows([work], realm, 'cedar', null)).toEqual([]);
  work.local = { [realm.id]: { kind: 'unavailable' } };
  expect(() => expectedPublicPhraseRows([work], realm, 'cedar', null))
    .toThrow('local publication is unavailable');
  expect(expectedPublicPhraseRows([{ ...work, main: null, local: {} }],
    realm, 'cedar', null)).toEqual([]);
});
