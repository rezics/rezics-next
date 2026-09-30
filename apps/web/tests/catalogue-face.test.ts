import { describe, expect, test } from 'bun:test';
import { initials } from '@rezics/ui/avatar-initials';
import { coverDesign, coverSeed } from '@rezics/ui/work-cover';
import { workKinds } from '../../../services/main/src/modules/work/work-kinds.ts';
import { seedServedTypes } from '../features/catalogue/type-fixtures.ts';
import { typeLabel } from '../features/catalogue/types.ts';
import { authorSeparator, coverKindOf, coverProps, otherLanguageTitle } from '../features/catalogue/work.ts';

const uuid = '0192f3a4-5b6c-7d8e-9f01-23456789abcd';
const name = (value: string, language: string, basis: 'requested' | 'fallback' = 'fallback') =>
  ({ value, language, direction: 'ltr' as const, basis });

describe('one face per Work', () => {
  test('every form of a Work’s id picks the same design, and Main’s per-read fallback keys do not', () => {
    for (const id of [`https://rezics.com/id/${uuid}`, uuid, `/w/${uuid.toUpperCase()}`, `/r/${'0'.repeat(8)}-0000-7000-8000-${'0'.repeat(12)}/w/${uuid}`]) {
      expect(coverSeed(id)).toBe(uuid);
      expect(coverDesign('book', id)).toEqual(coverDesign('book', uuid));
    }
    const work = { id: `https://rezics.com/id/${uuid}`, title: name('Pride and Prejudice', 'en'), kind: 'book' as const,
      authors: [{ name: 'Jane Austen', href: '/authors/open-library/OL21594A' }] };
    // Two reads that picked different fallback keys still give the cover the same props.
    const a = coverProps({ ...work, cover: { kind: 'fallback', policy: 'avatar-fallback-v1', key: 'a1', resourceType: 'work' } });
    const b = coverProps({ ...work, cover: { kind: 'fallback', policy: 'avatar-fallback-v1', key: 'b2', resourceType: 'work' } });
    expect(a).toEqual(b);
    expect(a).toMatchObject({ id: work.id, kind: 'book', title: 'Pride and Prejudice', authors: ['Jane Austen'], image: null });
  });

  test('every Work type Main knows draws one cover kind and has a name', () => {
    seedServedTypes();
    for (const type of Object.keys(workKinds)) {
      expect(coverKindOf([type]), type).not.toBeUndefined();
      expect(typeLabel([type], 'en'), type).toBeString();
    }
    expect(coverKindOf(['https://schema.org/Recipe'])).toBe('recipe');
    expect(coverKindOf(['https://rezics.com/vocab/ModPackage'])).toBe('package');
    expect(coverKindOf(['https://rezics.com/vocab/PromptTemplate'])).toBe('document');
    // A Work that is also a Book is drawn as one.
    expect(coverKindOf(['https://schema.org/DigitalDocument', 'https://schema.org/Book'])).toBe('book');
    // An untyped read draws its base's default, and names nothing.
    expect(coverKindOf([])).toBe('document');
    expect(typeLabel(['https://schema.org/DigitalDocument', 'https://rezics.com/vocab/PromptTemplate'], 'en'))
      .toBe('Prompt');
    expect(typeLabel([], 'en')).toBeNull();
  });

  test('a title is “shown in another language” only when its language differs from the interface’s', () => {
    expect(otherLanguageTitle(name('Pride and Prejudice', 'en'), 'en')).toBe(false);
    expect(otherLanguageTitle(name('Pride and Prejudice', 'en-GB'), 'en')).toBe(false);
    expect(otherLanguageTitle(name('西游记', 'zh-Hans'), 'en')).toBe(true);
    expect(otherLanguageTitle(name('西游记', 'zh'), 'zh-Hans')).toBe(false);
    // 簡體 and 繁體 are different scripts to a reader.
    expect(otherLanguageTitle(name('西遊記', 'zh-Hant'), 'zh-Hans')).toBe(true);
    // A requested title is in the reader's language by definition.
    expect(otherLanguageTitle(name('Pride and Prejudice', 'en', 'requested'), 'ja')).toBe(false);
    expect(otherLanguageTitle(null, 'en')).toBe(false);
  });

  test('avatars everywhere take their letters from one helper', () => {
    expect(initials('Jun Zhang 张俊')).toBe('JZ');
    expect(initials('Sophie Li 李素菲')).toBe('SL');
    expect(initials('月下书生 · Moonlit Scribe')).toBe('月');
  });

  test('credited names use the cover’s separator for Latin and CJK names', () => {
    expect(authorSeparator(['Jane Austen', 'Mary Shelley'])).toBe(', ');
    expect(authorSeparator(['林梅', 'Jane Austen'])).toBe('、');
  });

});
