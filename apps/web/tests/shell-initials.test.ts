import { describe, expect, test } from 'bun:test';
import { initials } from '@rezics/ui/avatar-initials';

// The milestone review found Daniel Chen 陈丹尼 as "D陈" in the header, "DC" on
// his profile and "DA" in settings. Every avatar now uses this one rule.
describe('avatar initials', () => {
  test('a mixed-script name takes two letters from its first alphabet only', () => {
    expect(initials('Daniel Chen 陈丹尼')).toBe('DC');
    expect(initials('Lin Mei 林梅')).toBe('LM');
    expect(initials('Daniel 陈丹尼')).toBe('D');
    expect(initials('North Star Editions · 北辰出版')).toBe('NS');
  });

  test('a Han, Kana or Hangul name shows its first character', () => {
    expect(initials('陈丹尼')).toBe('陈');
    expect(initials('月下书生 · Moonlit Scribe')).toBe('月');
    expect(initials('さくら')).toBe('さ');
    expect(initials('김민지')).toBe('김');
  });

  test('other alphabets, punctuation and empty names', () => {
    expect(initials('élodie')).toBe('É');
    expect(initials('Анна Петрова')).toBe('АП');
    expect(initials('@lin_mei')).toBe('L');
    expect(initials('42')).toBe('4');
    expect(initials('', 'R')).toBe('R');
  });
});
