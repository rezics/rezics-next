import { test } from 'bun:test';
import { publishBookOriginals } from './support/book-composition.ts';

test('cold Subject publication seals and discloses the three authored Book originals', async () => {
  const started = Date.now();
  const { fixture, published, originals } = await publishBookOriginals(started + 600_000, 180_000);
  try {
    console.info('Cold Subject publication', {
      generation: published.generation,
      originals: originals.length,
      elapsedMs: Date.now() - started,
    });
  } finally {
    await fixture.close(Date.now() + 180_000);
  }
}, 780_000);
