import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { MediaShowcaseStore } from '../src/modules/media/showcase-store.ts';
import { ShowcaseRefused } from '../src/modules/media/showcase-contract.ts';

const WORK = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const hex = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const admission = {
  admissionId: hex(2),
  principalId: hex(3),
  actingSubject: WORK,
  authorityEpoch: '1',
  requestDigest: 'a'.repeat(64),
};

/** A pool whose stored state is the currently selected logo languages. */
function poolWith(languages: string[]) {
  const statements: string[] = [];
  const client = {
    release() {},
    async query(sql: string) {
      statements.push(sql);
      if (sql.includes('array_agg')) return { rows: [{ languages }] };
      if (sql.includes('SELECT r.*,s.id')) return { rows: [] };
      if (sql.includes('SELECT head')) return { rows: [{ head: null }] };
      // Stop after admission: the test only asks whether the language fits.
      if (sql.includes('SELECT v.draft_head') || sql.includes('WITH terminal')) throw new Error('admitted');
      return { rows: [] };
    },
  };
  return { statements, pool: { connect: async () => client } as unknown as Pool };
}

const logo = (language: string, tone: 'dark' | 'light' = 'light') => ({
  target: WORK,
  context: 'urn:rezics:media:context:default',
  expectedSelection: null,
  role: 'logo' as const,
  language,
  tone,
  anchor: 'center-top' as const,
  asset: hex(9),
  crop: null,
  focalArea: null,
});

const eight = ['en', 'ja', 'zh-Hant', 'zh-Hans', 'ko', 'fr', 'de', 'es'];

test('a Work refuses a ninth logo language with a typed problem', async () => {
  const { pool } = poolWith(eight);
  await expect(
    new MediaShowcaseStore(pool).select(admission, logo('it'), async () => ({ width: 1, height: 1 })),
  ).rejects.toMatchObject({ code: 'showcase_logo_limit' });
  await expect(
    new MediaShowcaseStore(pool).select(admission, logo('it'), async () => ({ width: 1, height: 1 })),
  ).rejects.toBeInstanceOf(ShowcaseRefused);
});

test('a full Work still replaces a logo in a language it already has, in either tone', async () => {
  for (const tone of ['light', 'dark'] as const) {
    const { pool } = poolWith(eight);
    await expect(
      new MediaShowcaseStore(pool).select(admission, logo('ja', tone), async () => ({
        width: 1,
        height: 1,
      })),
    ).rejects.toThrow('admitted');
  }
});

test('removing a logo is never refused by the language cap', async () => {
  const { pool, statements } = poolWith(eight);
  await expect(
    new MediaShowcaseStore(pool).select(
      admission,
      { ...logo('it'), asset: null },
      async () => ({ width: 1, height: 1 }),
    ),
  ).rejects.toThrow('admitted');
  expect(statements.some((sql) => sql.includes('array_agg'))).toBe(false);
});
