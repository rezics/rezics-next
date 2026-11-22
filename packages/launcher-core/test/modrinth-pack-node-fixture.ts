import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { ZipFile } from 'yazl';
import { packIndexName } from '../src/plugins/modrinth-pack-format.ts';
import { ModrinthPacks } from '../src/plugins/modrinth-pack.ts';
import { fileInfo } from '../src/storage.ts';

const directory = process.argv[2]!;
const pack = new ModrinthPacks();
const overrides = [
  { path: 'resourcepacks/compressed.zip', bytes: randomBytes(4 * 1024 * 1024), compress: true },
  { path: 'resourcepacks/stored.zip', bytes: randomBytes(4 * 1024 * 1024), compress: false },
];
const index = Buffer.from(
  JSON.stringify({
    formatVersion: 1,
    game: 'minecraft',
    name: 'Large pack',
    versionId: '1',
    files: [],
    dependencies: { minecraft: '1.21.1' },
    ignoredPadding: randomBytes(2 * 1024 * 1024).toString('base64'),
  }),
);

for (const compress of [true, false]) {
  const mode = compress ? 'deflate' : 'stored';
  const source = join(directory, `${mode}.mrpack`);
  const zip = new ZipFile();
  zip.addBuffer(index, packIndexName, { compress });
  for (const override of overrides) {
    zip.addBuffer(override.bytes, `client-overrides/${override.path}`, { compress: override.compress });
  }
  zip.end();
  await pipeline(zip.outputStream, createWriteStream(source));

  const preview = await pack.inspect(source);
  assert.equal(
    preview.digest,
    createHash('sha256')
      .update(await readFile(source))
      .digest('hex'),
  );
  assert.equal(preview.preview.overrides.length, overrides.length);
  const instance = join(directory, 'instances', mode);
  const game = join(instance, 'game');
  await pack.apply(instance, game, source, preview.digest, preview.preview.selection);
  for (const override of overrides) {
    assert.deepEqual(await readFile(join(game, override.path)), override.bytes);
  }
  assert.equal(await fileInfo(join(instance, 'modrinth-pack-staging')), undefined);
}
