import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { zonePeople, zoneWork } from '../features/realm/adapt.ts';
import type { WorkCard } from '../features/realm/types.ts';
import { contentText, isolate, untaggedName, zoneContentText } from '../features/language/untagged.ts';
import { valueLabel } from '../features/zones/browse-view.ts';
import { zoneWorkCards } from '../features/zones/adapt-cards.ts';
import { messages } from '../features/zones/messages.ts';

const arabic = 'مكتبة الأدب';
const hebrew = 'עמוס עוז';
const iri = (id: string) => `https://rezics.com/id/${id}`;
const name = (value: string, language: string, direction: 'ltr' | 'rtl' = 'ltr') =>
  ({ value, language, direction, basis: 'requested' as const });
const card = (overrides: Partial<WorkCard> = {}): WorkCard => ({ id: iri('5f7a2c1e-8d3b-4c6a-9e2f-1b4d6a8c0e3f'),
  title: name('吾輩は猫である', 'ja'),
  cover: { kind: 'fallback', policy: 'p', key: 'k', resourceType: 'https://schema.org/Book' }, types: ['https://schema.org/Book'], tagline: null,
  completionStatus: 'ongoing', chapterCount: 1, wordCount: null, lastUpdatedAt: null, ...overrides });
const context = { locale: 'ko' as const, ref: 'fiction', realm: '7c3e9a1d-2b4f-4d6e-8a0c-5e7f9b1d3c2a' };
const credit = (displayName: string) => ({ agent: null, handle: null, displayName, provider: 'open-library',
  key: '/authors/OL1A' });

describe('G-516 content text keeps its own language and direction', () => {
  test('untagged content never gains a language and takes its direction from the text', () => {
    expect(zoneContentText(arabic)).toEqual({ value: arabic, lang: '', dir: 'rtl' });
    expect(zoneContentText('Untitled')).toEqual({ value: 'Untitled', lang: '', dir: 'ltr' });
    expect(contentText(hebrew)).toEqual({ value: hebrew, language: '', direction: 'rtl' });
    expect(untaggedName(arabic)).toEqual({ value: arabic, language: '', direction: 'rtl', basis: 'fallback' });
    // A recorded script wins over the letters; a recorded language is kept as given.
    expect(zoneContentText('Ahmad', 'ar')).toEqual({ value: 'Ahmad', lang: 'ar', dir: 'rtl' });
    expect(zoneContentText(arabic, 'ku-Latn')).toEqual({ value: arabic, lang: 'ku-Latn', dir: 'ltr' });
  });

  test('a Work card keeps Main’s title language and gives an untagged author no language', () => {
    const adapted = zoneWork({ ...card(), primaryCredits: [credit(arabic)] }, context, null);
    expect(adapted.title).toEqual({ value: '吾輩は猫である', lang: 'ja', dir: 'ltr' });
    expect(adapted.author).toEqual({ value: arabic, lang: '', dir: 'rtl' });
    expect(zoneWork({ ...card(), primaryCredits: [credit('Jane Austen')] }, context, null).author)
      .toEqual({ value: 'Jane Austen', lang: '', dir: 'ltr' });
  });

  test('a Hub preview is untagged, with its own direction', () => {
    const hub = (preview: string) => ({ profile: 'hub-work-card-v1' as const, kind: 'prompt' as const,
      declaredModels: [], testedModels: [], preview, copyText: preview });
    expect(zoneWorkCards({ hub: hub(arabic) }).hub?.preview).toEqual({ value: arabic, lang: '', dir: 'rtl' });
  });

  test('a people module names authors untagged and notes their Works in the language they share', () => {
    const [person] = zonePeople([{ title: name(arabic, 'ar', 'rtl'), primaryCredits: [credit(hebrew)] }], 5);
    expect(person!.name).toEqual({ value: hebrew, lang: '', dir: 'rtl' });
    expect(person!.note).toEqual({ value: arabic, lang: 'ar', dir: 'rtl' });
    const [mixed] = zonePeople([{ title: name('Tides', 'en'), primaryCredits: [credit('Jane')] },
      { title: name(arabic, 'ar', 'rtl'), primaryCredits: [credit('Jane')] }], 5);
    expect(mixed!.note?.lang).toBe('');
    const [plain] = zonePeople([{ title: name('Tides', 'en'), primaryCredits: [credit('Jane')] }], 5);
    expect(plain!.note).toEqual({ value: 'Tides', lang: 'en', dir: 'ltr' });
  });

  test('browse labels say the interface locale for the page’s words and nothing for raw values', () => {
    expect(valueLabel('status', 'ongoing', null, 'ko', messages)).toMatchObject({ lang: 'ko', dir: 'ltr' });
    expect(valueLabel('type', 'https://schema.org/Book', null, 'ja', messages)).toMatchObject({ lang: 'ja' });
    expect(valueLabel('status', 'unlisted', null, 'ko', messages)).toEqual({ value: 'unlisted', lang: '', dir: 'ltr' });
  });

  // The adapters keep one answer for direction and language; a literal would put the old assumption back.
  test('adapter sources carry no hard-coded direction or empty language literal', () => {
    const files = ['realm/adapt.ts', 'realm/modules.ts', 'zones/browse-view.ts', 'zones/adapt-cards.ts',
      'library/library-import.tsx', 'manage/parts.tsx', 'work-page/credits.tsx', 'work-page/work-header.tsx'];
    for (const file of files) {
      const source = readFileSync(new URL(`../features/${file}`, import.meta.url), 'utf8');
      expect(source.match(/\bdir(?:ection)?: 'ltr'|\blang(?:uage)?: ''/g) ?? [], file).toEqual([]);
    }
  });

  test('a name set into plain text is isolated, and content that sets lang also sets dir', () => {
    expect(isolate('مكتبة')).toBe('\u2068مكتبة\u2069');
    for (const file of ['realm/views.tsx', 'realm/thread-rail.tsx', 'catalogue/work-shelf.tsx', 'discover/discover-view.tsx']) {
      const source = readFileSync(new URL(`../features/${file}`, import.meta.url), 'utf8');
      const count = (pattern: RegExp) => source.match(pattern)?.length ?? 0;
      expect(count(/\blang=\{/g), file).toBeLessThanOrEqual(count(/\bdir=\{/g));
    }
  });
});
