import { randomUUID } from 'node:crypto';
import { afterEach, expect, test } from 'bun:test';
import { LOCAL_MEDIA_MAX_OBJECT_BYTES, LOCAL_MEDIA_ROOT, LocalMediaStorage } from '../../src/content/local-media.ts';

const storage = () => new LocalMediaStorage({ root: LOCAL_MEDIA_ROOT, maxObjectBytes: LOCAL_MEDIA_MAX_OBJECT_BYTES });
const ownedMediaIds = new Set<string>();

afterEach(async () => {
  for (const mediaId of ownedMediaIds) await storage().deletePrefix(`m/${mediaId}/`);
  ownedMediaIds.clear();
});

test('local media survives adapter restart, atomically replaces a key, and deletes only its exact media prefix', async () => {
  const mediaId = randomUUID();
  const siblingId = randomUUID();
  ownedMediaIds.add(mediaId);
  ownedMediaIds.add(siblingId);
  const key = `m/${mediaId}/original`;
  const sibling = `m/${siblingId}/webp-320`;
  const first = new Uint8Array([1, 2, 3]);
  const replacement = new Uint8Array([4, 5, 6, 7]);
  const writer = storage();
  await writer.put(key, first, { mediaType: 'image/jpeg' });
  await writer.put(sibling, first, { mediaType: 'image/webp' });

  const restartedWorker = storage();
  await restartedWorker.put(key, replacement, { mediaType: 'image/jpeg' });
  expect(await restartedWorker.get(key)).toEqual(replacement);
  expect(await restartedWorker.get(sibling)).toEqual(first);
  await restartedWorker.deletePrefix(`m/${mediaId}/`);
  expect(await restartedWorker.get(key)).toBeNull();
  expect(await restartedWorker.get(sibling)).toEqual(first);
});

test('local media rejects path-shaped keys and writes larger than the shared object bound', async () => {
  const writer = storage();
  expect(() => writer.put('../outside', new Uint8Array([1]), { mediaType: 'image/jpeg' })).toThrow(
    'Invalid local media key',
  );
  expect(() => writer.deletePrefix('m/../')).toThrow('Invalid local media prefix');
  expect(() =>
    writer.put(`m/${randomUUID()}/original`, new Uint8Array(LOCAL_MEDIA_MAX_OBJECT_BYTES + 1), {
      mediaType: 'image/jpeg',
    }),
  ).toThrow('byte limit');
});
