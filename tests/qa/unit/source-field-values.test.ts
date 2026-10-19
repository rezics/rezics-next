import { expect, test } from 'bun:test';
import { nativeFieldDigest, type NativeFieldControlIntent } from '../../../services/main/src/modules/source/field-control-native.ts';
import { SYNOPSIS_TEXT_LIMIT, suppliedLanguage, synopsisPropertyValue, validSynopsisText,
  validSuppliedLanguage } from '../../../services/main/src/modules/source/field-control-language.ts';

const work = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const intent: NativeFieldControlIntent = { profile: 'work-editorial-field-control-v1',work,field: 'synopsis',
  expectedWorkHead: work,basis: { contentHead: null,head: null,epoch: '0',protection: null },
  value: ' First line\r\nSecond line\t終わり ',origin: 'human',source: null };

test('native synopsis preserves multiline and oversized text exactly within its declared bound', () => {
  const text = `${intent.value}${'文'.repeat(9000)}`;
  expect(validSynopsisText(text)).toBe(true);
  expect(nativeFieldDigest({ ...intent,value: text })).not.toBe(nativeFieldDigest({ ...intent,value: text.trim() }));
  expect(nativeFieldDigest({ ...intent,value: text })).not.toBe(nativeFieldDigest({ ...intent,value: text.replaceAll('\r\n','\n') }));
  expect(validSynopsisText('a'.repeat(SYNOPSIS_TEXT_LIMIT))).toBe(true);
  expect(validSynopsisText('a'.repeat(SYNOPSIS_TEXT_LIMIT + 1))).toBe(false);
  for (const value of ['', 'bad\u0000text', 'bad\u000btext']) {
    expect(() => nativeFieldDigest({ ...intent,value })).toThrow();
  }
});

test('native source-language evidence distinguishes omitted, null, empty and supplied tags', () => {
  const languages = [suppliedLanguage({}),suppliedLanguage({ language: null }),
    suppliedLanguage({ language: '' }),suppliedLanguage({ language: 'EN-us' })];
  expect(languages).toEqual([{ state: 'omitted' },{ state: 'null' },{ state: 'value',value: '' },
    { state: 'value',value: 'EN-us' }]);
  expect(new Set(languages.map(language => nativeFieldDigest({ ...intent,language }))).size).toBe(4);
  expect(synopsisPropertyValue(intent.value,languages[3]!)).toEqual({ kind: 'language-string',
    lexical: intent.value,language: 'en-US' });
  expect(languages[3]).toEqual({ state: 'value',value: 'EN-us' });
  for (const language of languages.slice(0,3)) {
    expect(synopsisPropertyValue(intent.value,language)).toEqual({ kind: 'string',lexical: intent.value });
  }
  expect(validSuppliedLanguage({ state: 'omitted',value: 'ja' })).toBe(false);
  expect(validSuppliedLanguage({ state: 'value' })).toBe(false);
  expect(validSuppliedLanguage({ state: 'value',value: '\n' })).toBe(false);
});
