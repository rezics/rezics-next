import { expect, test } from 'bun:test';
import { readImagePresentationBatches } from '../src/editor/media-presentation-batches';

test('33+ image references use bounded concurrent native-sized batches and retain successful facts when another fails', async () => {
  const ids = Array.from({ length: 97 }, (_, index) => `image-${index}`);
  let active = 0,
    maximum = 0;
  const requests: string[][] = [];
  const settled = new Set<string>();
  const images = new Map<string, { id: string }>();
  await readImagePresentationBatches(
    ids,
    async (batch) => {
      requests.push(batch);
      active++;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      active--;
      if (batch[0] === 'image-32') throw new Error('one batch unavailable');
      return { kind: 'ready', images: batch.map((id) => ({ id })) };
    },
    (batch, received) => {
      batch.forEach((id) => settled.add(id));
      received.forEach((image) => images.set(image.id, image));
    },
    () => true,
  );
  expect(requests.map((batch) => batch.length)).toEqual([32, 32, 32, 1]);
  expect(maximum).toBeLessThanOrEqual(2);
  expect(settled.size).toBe(97);
  expect(images.has('image-96')).toBe(true);
  expect(images.has('image-32')).toBe(false);
  expect(images.size).toBe(65);
});

test('viewer/visit retirement suppresses late image facts and stops queued batch reads', async () => {
  let current = true;
  let requests = 0,
    published = 0;
  const finish: (() => void)[] = [];
  const pending = readImagePresentationBatches(
    Array.from({ length: 100 }, (_, i) => String(i)),
    async (batch) => {
      requests++;
      await new Promise<void>((resolve) => finish.push(resolve));
      return { kind: 'ready', images: batch.map((id) => ({ id })) };
    },
    () => {
      published++;
    },
    () => current,
  );
  expect(requests).toBe(2);
  current = false;
  finish.forEach((resolve) => resolve());
  await pending;
  expect(requests).toBe(2);
  expect(published).toBe(0);
});
