import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectSelectedVndbCharacterNameRows, CrossMediaDumpFiles } from '../src/cross-media-seed.ts';

test('selected COPY character-name rows keep their table owner, language and spoiler cells', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vndb-character-names-'));
  const db = join(directory, 'db');
  await mkdir(db);
  try {
    await writeFile(join(db, 'chars_names.header'), 'id\tlang\tname\tlatin\n');
    await writeFile(
      join(db, 'chars_names'),
      'c1\tja\t名前\tNamae\nc1\tzh-Hant\t名字\t\\N\nc2\tja\tShared spelling\t\\N\n',
    );
    await writeFile(join(db, 'chars_alias.header'), 'id\tspoil\tname\tlatin\n');
    await writeFile(join(db, 'chars_alias'), 'c1\t2\tShared alias\t\\N\nc2\t1\tShared alias\t\\N\n');
    const input = new CrossMediaDumpFiles(directory, directory);
    const selected = await collectSelectedVndbCharacterNameRows(input, new Set(['c1']));
    expect(selected.names.get('c1')).toEqual([
      { id: 'c1', lang: 'ja', name: '名前', latin: 'Namae' },
      { id: 'c1', lang: 'zh-Hant', name: '名字', latin: null },
    ]);
    expect(selected.aliases.get('c1')).toEqual([{ id: 'c1', spoil: '2', name: 'Shared alias', latin: null }]);
    expect(selected.names.has('c2')).toBe(false);
    expect(selected.aliases.has('c2')).toBe(false);
    expect(selected.overflow.size).toBe(0);

    await writeFile(join(db, 'chars_alias.header'), 'id\tname\tspoil\tlatin\n');
    await expect(
      Array.fromAsync(new CrossMediaDumpFiles(directory, directory).rows('vndb', 'chars_alias')),
    ).rejects.toThrow('Invalid VNDB chars_alias header');
    await writeFile(join(db, 'chars_alias.header'), 'id\tspoil\tname\tlatin\n');
    await writeFile(
      join(db, 'chars_alias'),
      Array.from({ length: 65 }, (_, index) => `c1\t2\tAlias ${index}\t\\N`).join('\n') + '\n',
    );
    const overflow = await collectSelectedVndbCharacterNameRows(
      new CrossMediaDumpFiles(directory, directory),
      new Set(['c1']),
    );
    expect(overflow.aliases.get('c1')).toHaveLength(64);
    expect(overflow.overflow.get('c1')?.reason).toBe('row_limit');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
