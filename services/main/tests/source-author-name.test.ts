import { expect, test } from 'bun:test';
import { projectOpenLibraryAuthor } from '../src/modules/source/author-name.ts';
import { OpenLibraryAcquisitionUnavailable } from '../src/modules/source/open-library.ts';
import { readAuthorNames, fenceAuthorNames } from '../src/modules/source/author-name-read.ts';
import { WorkReadMoved, type WorkReadSession } from '../src/modules/work/read-session.ts';

const key = '/authors/OL1A';
const author = { key, name: 'Ursula K. Le Guin', type: { key: '/type/author' }, revision: 2 };
test('Open Library labels retain only the factual name and distinguish absence from malformed capture', () => {
  expect(projectOpenLibraryAuthor(key, { ...author, bio: 'Not adopted', photos: [123] }))
    .toEqual({ displayName: 'Ursula K. Le Guin', sourceRevision: 'open-library-revision:2' });
  expect(projectOpenLibraryAuthor(key, { ...author, name: undefined }).displayName).toBeNull();
  for (const value of [{ ...author, key: '/authors/OL2A' }, { ...author, type: { key: '/type/work' } },
    { ...author, name: '' }, { ...author, name: null }, { ...author, name: 'x'.repeat(201) },
    { ...author, name: 'line\nbreak' }, { ...author, revision: undefined }]) {
    expect(() => projectOpenLibraryAuthor(key, value)).toThrow(OpenLibraryAcquisitionUnavailable);
  }
});

test('author label fence detects removal and refresh after a page read', async () => {
  let name: unknown = { displayName: 'Before', nameSource: { revision: '1' } };
  const session = { deps: { sourceAuthorNames: { batch: async () => new Map(name ? [[key, name]] : []) } },
    checkDeadline: () => {} } as unknown as WorkReadSession;
  expect((await readAuthorNames(session, [key, key])).get(key)?.displayName).toBe('Before');
  await fenceAuthorNames(session);
  name = { displayName: 'After', nameSource: { revision: '2' } };
  await expect(fenceAuthorNames(session)).rejects.toBeInstanceOf(WorkReadMoved);
  name = null;
  await expect(fenceAuthorNames(session)).rejects.toBeInstanceOf(WorkReadMoved);
});
