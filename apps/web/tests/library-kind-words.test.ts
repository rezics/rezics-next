import { beforeEach, describe, expect, test } from 'bun:test';
import { materializeData } from 'native-i18n';
import { catalogs } from '../i18n/catalogs.ts';
import { seedServedTypes } from '../features/catalogue/type-fixtures.ts';
import { uiLocales } from '../i18n/define.ts';
import { hasKindWords, rowStatusLabel, shelfVerbOf } from '../features/library/labels.ts';
import { shelfWords } from '../features/work-page/shelf-words.ts';

const kinds = {
  book: 'https://schema.org/Book',
  game: 'https://schema.org/VideoGame',
  recipe: 'https://schema.org/Recipe',
  software: 'https://schema.org/SoftwareApplication',
  prompt: 'https://rezics.com/vocab/PromptTemplate',
} as const;
const row = (type: string, status: 'want-to-read' | 'reading' | 'read') => ({ types: [type], status }) as never;

describe('shelf words in the Work\'s own verb', () => {
  beforeEach(seedServedTypes);
  const english = async () => materializeData(await catalogs.library.en() as never, { locale: 'en' }) as never;

  test('the Library words each kind\'s three statuses as the Work page does', async () => {
    const t = await english();
    const said = (type: string) => (['want-to-read', 'reading', 'read'] as const).map(status => rowStatusLabel(row(type, status), t));
    expect(said(kinds.book)).toEqual(['Want to read', 'Currently reading', 'Read']);
    expect(said(kinds.game)).toEqual(['Want to play', 'Playing', 'Played']);
    expect(said(kinds.recipe)).toEqual(['Want to cook', 'Cooking', 'Cooked']);
    expect(said(kinds.software)).toEqual(['Want to use', 'Using', 'Used']);
    expect(said(kinds.prompt)).toEqual(['Want to use', 'Using', 'Used']);
    expect(rowStatusLabel({ types: [kinds.game], status: null } as never, t)).toBeNull();
  });

  test('only a kind with its own words says which shelf its row is on', () => {
    expect(hasKindWords({ types: [kinds.book] })).toBe(false);
    expect(['game', 'recipe', 'software', 'prompt'].map(kind => shelfVerbOf({ types: [kinds[kind as keyof typeof kinds]] })))
      .toEqual(['play', 'cook', 'use', 'use']);
  });

  test('the Library and the Work page word every kind identically in every locale', async () => {
    const experiences = {
      game: { kind: 'plain', presentation: 'game', primaryAction: 'visit' },
      recipe: { kind: 'recipe', presentation: 'recipe', primaryAction: 'read' },
      software: { kind: 'plain', presentation: 'default', primaryAction: 'install' },
    } as const;
    for (const locale of uiLocales) {
      const lib = materializeData(await catalogs.library[locale]() as never, { locale }) as never;
      const page = materializeData(await catalogs.workPage[locale]() as never, { locale }) as never;
      const words = (kind: keyof typeof experiences) => shelfWords(experiences[kind], page as never)!;
      const rowWords = (type: string) => (['want-to-read', 'reading', 'read'] as const).map(status => rowStatusLabel(row(type, status), lib));
      for (const [kind, type] of [['game', kinds.game], ['recipe', kinds.recipe], ['software', kinds.software]] as const) {
        const page = words(kind);
        expect(rowWords(type), `${locale} ${kind}`).toEqual([page.wantToRead, page.reading, page.read]);
      }
    }
  });
});
