import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { SourceArchiveConflict, SourceArchiveInvalid, SourceArchiveUnavailable, verifyVndbCopyRow,
  type VndbCopyCoordinate } from '../src/modules/source/archive-copy.ts';
import { retainedTar } from './support/source-archive-fixture.ts';

const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const decoded = { id: 'c13', image: 'ch41', name: 'A\tB\nC\\D' };
const digest = sha(JSON.stringify(decoded));
const raw = 'c13\tch41\tA\\tB\\nC\\134D\n';
const coordinate: VndbCopyCoordinate = { table: 'chars', rowOrdinal: 0, rowDigest: digest,
  fieldLocator: '/image', imageId: 'ch41', namespace: 'character', externalId: 'c13', role: 'portrait' };
const archive = () => retainedTar([['db/chars', raw + raw], ['db/chars.header', 'id\timage\tname\n']]);

test('COPY verification retains original duplicate ordinals and exact decoded bytes', async () => {
  const first = await verifyVndbCopyRow(archive(), 'application/x-tar', coordinate);
  const second = await verifyVndbCopyRow(archive(), 'application/x-tar', { ...coordinate, rowOrdinal: 1 });
  expect(first.decodedRow).toEqual(decoded);
  expect(Buffer.from(first.decodedBytes).toString()).toBe(JSON.stringify(decoded));
  expect(first.rowDigest).toBe(sha(first.decodedBytes));
  expect(first.imageUrl).toBe('https://t.vndb.org/ch/41/41.jpg');
  expect(first.rowOrdinal).toBe(0);
  expect(second.rowOrdinal).toBe(1);
  expect(second.decodedBytes).toEqual(first.decodedBytes);
  await expect(verifyVndbCopyRow(archive(), 'application/x-tar', { ...coordinate, rowOrdinal: 2 }))
    .rejects.toBeInstanceOf(SourceArchiveUnavailable);
});

test('compressed original archive and decoded COPY row have separate digests', async () => {
  const compressed = Bun.zstdCompressSync(archive());
  const row = await verifyVndbCopyRow(compressed, 'application/zstd', coordinate);
  expect(row.rowDigest).toBe(digest);
  expect(sha(compressed)).not.toBe(row.rowDigest);
});

test('COPY witness refuses a changed source, field, digest or capture role', async () => {
  for (const change of [{ rowDigest: 'a'.repeat(64) }, { externalId: 'c14' }, { imageId: 'ch42' }]) {
    await expect(verifyVndbCopyRow(archive(), 'application/x-tar', { ...coordinate, ...change }))
      .rejects.toBeInstanceOf(SourceArchiveConflict);
  }
  for (const change of [{ fieldLocator: '/name' }, { role: 'screenshot' as const },
    { namespace: 'vn' as const }, { rowOrdinal: -1 }, { rowOrdinal: Number.NaN }]) {
    await expect(verifyVndbCopyRow(archive(), 'application/x-tar', { ...coordinate, ...change }))
      .rejects.toBeInstanceOf(SourceArchiveInvalid);
  }
});

test('cover and screenshot roles come from their actual COPY tables and columns', async () => {
  const rows = [
    { table: 'vn' as const, raw: 'v11\tcv123\n', header: 'id\timage\n', row: { id: 'v11', image: 'cv123' },
      fieldLocator: '/image', imageId: 'cv123', role: 'cover' as const },
    { table: 'vn_screenshots' as const, raw: 'v11\tsf123\n', header: 'id\tscr\n', row: { id: 'v11', scr: 'sf123' },
      fieldLocator: '/scr', imageId: 'sf123', role: 'screenshot' as const },
  ];
  for (const row of rows) {
    const bytes = retainedTar([[`db/${row.table}.header`, row.header], [`db/${row.table}`, row.raw]]);
    const witness = await verifyVndbCopyRow(bytes, 'application/x-tar', { table: row.table, rowOrdinal: 0,
      rowDigest: sha(JSON.stringify(row.row)), fieldLocator: row.fieldLocator, imageId: row.imageId,
      role: row.role, namespace: 'vn', externalId: 'v11' });
    expect(witness.role).toBe(row.role);
    expect(witness.imageId).toBe(row.imageId);
  }
});

test('COPY witness refuses malformed, substituted or ambiguous archive bytes', async () => {
  const cases = [
    Buffer.from(JSON.stringify({ url: 'https://t.vndb.org/ch/41/41.jpg' })),
    archive().subarray(0, archive().length - 1024),
    retainedTar([['../db/chars', raw], ['db/chars.header', 'id\timage\tname\n']]),
    retainedTar([['db/chars', raw], ['db/chars', raw], ['db/chars.header', 'id\timage\tname\n']]),
    retainedTar([['db/chars', 'c13\tch41\n'], ['db/chars.header', 'id\timage\tname\n']]),
    retainedTar([['db/chars', raw], ['db/chars.header', 'id\timage\timage\n']]),
    retainedTar([['db/chars', `c13\tch41\t${'x'.repeat(262_145)}\n`], ['db/chars.header', 'id\timage\tname\n']]),
  ];
  for (const bytes of cases) await expect(verifyVndbCopyRow(bytes, 'application/x-tar', coordinate))
    .rejects.toBeInstanceOf(SourceArchiveInvalid);
  const corrupted = archive(); corrupted[0] = 1;
  await expect(verifyVndbCopyRow(corrupted, 'application/x-tar', coordinate)).rejects.toBeInstanceOf(SourceArchiveInvalid);
});
