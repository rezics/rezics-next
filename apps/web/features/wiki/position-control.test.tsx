import { direction } from '@rezics/main/language';
import { describe, expect, test } from 'bun:test';
import type { EntityPickerPage } from '@rezics/ui/entity-picker';
import { uiLocales } from '../../i18n/define.ts';
import type { MainClient } from '../discover/types.ts';
import { copyOf } from './messages.ts';
import {
  loadPositionPickerPage,
  PositionReadError,
  positionChooserNotice,
  readReadingPositionPage,
  type PositionPickerItem,
} from './position-picker.ts';

const work = 'https://rezics.com/id/00000000-0000-4000-8000-000000009999';
const choice = (label: string): PositionPickerItem => ({
  value: label,
  label,
  text: { value: label, lang: 'en', dir: direction('en', label) },
  href: `/wiki?position=${label}`,
  current: false,
});
const page = (label: string, nextCursor: string | null = null): EntityPickerPage<PositionPickerItem> => ({
  items: [choice(label)],
  nextCursor,
  complete: nextCursor === null,
});

function client(get: (query: Record<string, unknown>) => Promise<unknown>): MainClient {
  return {
    v1: {
      'reading-positions': () => ({
        get: ({ query }: { query: Record<string, unknown> }) => get(query),
      }),
    },
  } as unknown as MainClient;
}

describe('numeric position jump', () => {
  test('reading_seek_unavailable maps to the number-jump message in every locale', () => {
    const english = 'Jumping by number is not available for this series yet. Browse the list or search by title.';
    expect(copyOf('en').numberSeekUnavailable).toBe(english);
    for (const locale of uiLocales) {
      const copy = copyOf(locale);
      expect(positionChooserNotice('reading_seek_unavailable', copy)).toBe(copy.numberSeekUnavailable);
      expect(copy.numberSeekUnavailable.trim()).not.toBe('');
      if (locale !== 'en') expect(copy.numberSeekUnavailable).not.toBe(english);
    }
    expect(positionChooserNotice('reading_resume_index_unavailable', copyOf('en'))).toBeNull();
    expect(positionChooserNotice('reading_continuity_unsupported', copyOf('de'))).toBeNull();
    expect(positionChooserNotice(undefined, copyOf('ja'))).toBeNull();
  });

  test('the reading-position problem code is kept, and any other failure stays a status', async () => {
    const calls: Record<string, unknown>[] = [];
    const seek = client(async (query) => {
      calls.push(query);
      return { data: null, error: { status: 503, value: { code: 'reading_seek_unavailable', status: 503 } } };
    });
    await expect(readReadingPositionPage(seek, { work, q: '12' })).rejects.toEqual(
      expect.objectContaining({ status: 503, code: 'reading_seek_unavailable' }),
    );
    expect(calls).toEqual([{ q: '12', limit: 50 }]);
    await expect(readReadingPositionPage(seek, { work, q: '12' })).rejects.toBeInstanceOf(PositionReadError);

    const resume = client(async () => ({
      data: null,
      error: { status: 503, value: { code: 'reading_resume_index_unavailable' } },
    }));
    await expect(readReadingPositionPage(resume, { work, q: '12' })).rejects.toMatchObject({
      status: 503,
      code: 'reading_resume_index_unavailable',
    });
    const plain = client(async () => ({ data: null, error: { status: 503 } }));
    await expect(readReadingPositionPage(plain, { work })).rejects.toMatchObject({ status: 503, code: undefined });
  });

  test('a refused number keeps the list and its pages, and title search and other errors do not', async () => {
    const calls: { q: string; cursor: string | null }[] = [];
    const fetchPage = async (query: { q: string; cursor: string | null }) => {
      calls.push(query);
      if (/^\d+$/.test(query.q)) throw new PositionReadError(503, 'reading_seek_unavailable');
      if (query.q === 'down') throw new PositionReadError(503, 'reading_resume_index_unavailable');
      if (query.q === 'lantern') return page('The lantern market');
      return page(query.cursor ? 'Chapter 21' : 'Chapter 1', query.cursor ? null : '20');
    };
    const first = await loadPositionPickerPage({ q: '', cursor: null }, fetchPage, {
      refusedQuery: null,
      browseFirst: null,
    });
    expect(first.page.items.map((item) => item.label)).toEqual(['Chapter 1']);
    expect(first.refusedQuery).toBeNull();

    const refused = await loadPositionPickerPage({ q: '12', cursor: null }, fetchPage, first);
    expect(refused.refusedQuery).toBe('12');
    expect(refused.page.items.map((item) => item.label)).toEqual(['Chapter 1']);
    expect(calls.filter((call) => call.q === '')).toHaveLength(1);

    const next = await loadPositionPickerPage({ q: '12', cursor: '20' }, fetchPage, refused);
    expect(next.refusedQuery).toBe('12');
    expect(next.page.items.map((item) => item.label)).toEqual(['Chapter 21']);
    expect(calls.at(-1)).toEqual({ q: '', cursor: '20' });

    const title = await loadPositionPickerPage({ q: 'lantern', cursor: null }, fetchPage, next);
    expect(title.refusedQuery).toBeNull();
    expect(title.page.items.map((item) => item.label)).toEqual(['The lantern market']);
    expect(calls.at(-1)).toEqual({ q: 'lantern', cursor: null });

    await expect(
      loadPositionPickerPage({ q: 'down', cursor: null }, fetchPage, title),
    ).rejects.toMatchObject({ status: 503, code: 'reading_resume_index_unavailable' });
    await expect(
      loadPositionPickerPage({ q: '12', cursor: '20' }, fetchPage, { refusedQuery: null, browseFirst: first.browseFirst }),
    ).rejects.toMatchObject({ code: 'reading_seek_unavailable' });
  });
});
