import { expect, mock, test } from 'bun:test';
import type { MangaRow } from '../src/features/catalogue/manga-profile-field';

test('retired Manga snapshots preserve the assertion and omit cached target labels', async () => {
  mock.module('cloudflare:workers', () => ({ env: {} }));
  const { mangaRetiredAssertionSnapshot, retiredMangaRowPopulated } =
    await import('../src/features/catalogue/manga-profile-view');
  const url = 'https://example.org/retained-source';
  const row: MangaRow = {
    id: 'retired',
    statement: {
      property: { id: 'schema:author' },
      value: { type: 'value', content: '00000000-0000-4000-8000-00000000a001' },
      qualifiers: [{ property: { id: 'schema:position' }, value: { type: 'value', content: '2' } }],
      references: [{ parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: url } }] }],
      rank: 'normal',
    },
    targets: { 'schema:author': [{ id: '00000000-0000-4000-8000-00000000a001', title: 'Cached target label', types: ['schema:Person'] }] },
  };
  try {
    const snapshot = mangaRetiredAssertionSnapshot(row);
    expect(snapshot).toBe(JSON.stringify(row.statement, null, 2));
    expect(snapshot).toContain('schema:position');
    expect(snapshot).toContain(url);
    expect(snapshot).not.toContain('Cached target label');
    expect(retiredMangaRowPopulated(row)).toBe(true);
    expect(
      retiredMangaRowPopulated({
        id: 'blank',
        statement: {
          property: { id: 'schema:inLanguage' },
          value: { type: 'value', content: '' },
          qualifiers: [],
          references: [],
          rank: 'normal',
        },
      }),
    ).toBe(false);
  } finally {
    mock.restore();
  }
});
