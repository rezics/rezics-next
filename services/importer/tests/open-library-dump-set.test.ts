import { expect, test } from 'bun:test';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  OPEN_LIBRARY_DUMP_SET_MAX_MEMBERS,
  admitOpenLibraryDumpSet,
  OpenLibraryDumpSetError,
} from '../src/open-library-dump-set.ts';
import workSource from '../../../specs/fixtures/imports/open-library/work.json';
import editionSource from '../../../specs/fixtures/imports/open-library/edition.json';

const author = {
  type: { key: '/type/author' },
  key: '/authors/OL900000001A',
  revision: 1,
  last_modified: { type: '/type/datetime', value: '2025-01-01T00:00:00Z' },
  name: 'Ada Example',
};

function row(record: { type: { key: string }; key: string; revision: number; last_modified?: { value: string } }) {
  const date = record.last_modified?.value ?? '2025-01-01T00:00:00Z';
  return `${[record.type.key, record.key, record.revision, date, JSON.stringify(record)].join('\t')}\n`;
}

async function directory() {
  return mkdtemp('/dev/shm/ol-dump-set-');
}

async function writeSet(
  root: string,
  files: { authors?: string; works?: string; editions?: string },
  extra: Record<string, unknown> = {},
) {
  await writeFile(join(root, 'authors.txt'), files.authors ?? row(author), { mode: 0o600 });
  await writeFile(join(root, 'works.txt'), files.works ?? row(workSource), { mode: 0o600 });
  await writeFile(join(root, 'editions.txt'), files.editions ?? row(editionSource), { mode: 0o600 });
  const manifest = {
    version: 1,
    source: 'openlibrary',
    members: [
      { family: 'author', path: 'authors.txt' },
      { family: 'work', path: 'works.txt' },
      { family: 'edition', path: 'editions.txt' },
    ],
    ...extra,
  };
  const path = join(root, 'manifest.json');
  await writeFile(path, JSON.stringify(manifest), { mode: 0o600 });
  return path;
}

test('admits a version-1 manifest with all three families and resolves relative paths', async () => {
  const root = await directory();
  try {
    const path = await writeSet(root, {});
    const admitted = await admitOpenLibraryDumpSet(path);
    expect(admitted.sourceKind).toBe('openlibrary');
    expect(admitted.members.map((member) => member.family)).toEqual(['author', 'work', 'edition']);
    expect(admitted.members.map((member) => member.path)).toEqual([
      join(root, 'authors.txt'),
      join(root, 'works.txt'),
      join(root, 'editions.txt'),
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('allows explicitly empty member files when every family is named', async () => {
  const root = await directory();
  try {
    const path = await writeSet(root, { authors: '', works: row(workSource), editions: row(editionSource) });
    const admitted = await admitOpenLibraryDumpSet(path);
    expect(admitted.members).toHaveLength(3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const rejections: [string, (root: string) => Promise<void>][] = [
  [
    'unsupported version',
    async (root) => {
      await writeSet(root, {});
      await writeFile(join(root, 'manifest.json'), JSON.stringify({ version: 3, source: 'openlibrary', members: [] }));
    },
  ],
  [
    'version-1 member with compression field',
    async (root) => {
      await writeSet(root, {});
      await writeFile(
        join(root, 'manifest.json'),
        JSON.stringify({
          version: 1,
          source: 'openlibrary',
          members: [
            { family: 'author', path: 'authors.txt', compression: 'none' },
            { family: 'work', path: 'works.txt' },
            { family: 'edition', path: 'editions.txt' },
          ],
        }),
      );
    },
  ],
  [
    'version-2 member omitting compression',
    async (root) => {
      await writeSet(root, {});
      await writeFile(
        join(root, 'manifest.json'),
        JSON.stringify({
          version: 2,
          source: 'openlibrary',
          members: [
            { family: 'author', path: 'authors.txt' },
            { family: 'work', path: 'works.txt', compression: 'none' },
            { family: 'edition', path: 'editions.txt', compression: 'gzip' },
          ],
        }),
      );
    },
  ],
  [
    'duplicate JSON fields',
    async (root) => {
      await writeSet(root, {});
      await writeFile(
        join(root, 'manifest.json'),
        '{"version":1,"version":1,"source":"openlibrary","members":[{"family":"author","path":"authors.txt"},{"family":"work","path":"works.txt"},{"family":"edition","path":"editions.txt"}]}',
      );
    },
  ],
  [
    'omitted family',
    async (root) => {
      await writeFile(join(root, 'works.txt'), row(workSource));
      await writeFile(join(root, 'editions.txt'), row(editionSource));
      await writeFile(
        join(root, 'manifest.json'),
        JSON.stringify({
          version: 1,
          source: 'openlibrary',
          members: [
            { family: 'work', path: 'works.txt' },
            { family: 'edition', path: 'editions.txt' },
          ],
        }),
      );
    },
  ],
  [
    'repeated member path',
    async (root) => {
      await writeSet(root, {});
      await writeFile(
        join(root, 'manifest.json'),
        JSON.stringify({
          version: 1,
          source: 'openlibrary',
          members: [
            { family: 'author', path: 'authors.txt' },
            { family: 'work', path: 'works.txt' },
            { family: 'edition', path: 'works.txt' },
          ],
        }),
      );
    },
  ],
  [
    'URL member path',
    async (root) => {
      await writeSet(root, {});
      await writeFile(
        join(root, 'manifest.json'),
        JSON.stringify({
          version: 1,
          source: 'openlibrary',
          members: [
            { family: 'author', path: 'https://example.invalid/authors.txt' },
            { family: 'work', path: 'works.txt' },
            { family: 'edition', path: 'editions.txt' },
          ],
        }),
      );
    },
  ],
];

for (const [name, prepare] of rejections) {
  test(`rejects ${name} before opening members as a capture`, async () => {
    const root = await directory();
    try {
      await prepare(root);
      await expect(admitOpenLibraryDumpSet(join(root, 'manifest.json'))).rejects.toBeInstanceOf(
        OpenLibraryDumpSetError,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('rejects a missing member and a symlink member', async () => {
  const root = await directory();
  try {
    await writeSet(root, {});
    await rm(join(root, 'editions.txt'));
    await expect(admitOpenLibraryDumpSet(join(root, 'manifest.json'))).rejects.toBeInstanceOf(OpenLibraryDumpSetError);
    await writeFile(join(root, 'editions.txt'), row(editionSource));
    await rm(join(root, 'works.txt'));
    await symlink('/etc/hosts', join(root, 'works.txt'));
    await expect(admitOpenLibraryDumpSet(join(root, 'manifest.json'))).rejects.toBeInstanceOf(OpenLibraryDumpSetError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects reserved path confusion with the state file', async () => {
  const root = await directory();
  try {
    const path = await writeSet(root, {});
    await expect(admitOpenLibraryDumpSet(path, { state: join(root, 'authors.txt') })).rejects.toBeInstanceOf(
      OpenLibraryDumpSetError,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('member ceiling is 64 and is not pre-allocated', async () => {
  expect(OPEN_LIBRARY_DUMP_SET_MAX_MEMBERS).toBe(64);
});

test('admits a version-2 manifest with explicit per-member none and gzip', async () => {
  const root = await directory();
  try {
    await writeSet(root, {});
    await writeFile(join(root, 'authors.txt.gz'), '');
    await writeFile(
      join(root, 'manifest.json'),
      JSON.stringify({
        version: 2,
        source: 'openlibrary',
        members: [
          { family: 'author', path: 'authors.txt.gz', compression: 'gzip' },
          { family: 'work', path: 'works.txt', compression: 'none' },
          { family: 'edition', path: 'editions.txt', compression: 'gzip' },
        ],
      }),
    );
    const admitted = await admitOpenLibraryDumpSet(join(root, 'manifest.json'));
    expect(admitted.version).toBe(2);
    expect(admitted.members.map((member) => member.compression)).toEqual(['gzip', 'none', 'gzip']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
