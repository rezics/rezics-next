import { expect, mock, test } from 'bun:test';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import active from '../src/kernel/recorded/definitions-active.json';
import recorded from '../src/kernel/recorded/definitions-release.json';

const kernelOrigin = 'https://definitions-recording-test.invalid';
const workerEnv: { KERNEL_ORIGIN: string } = { KERNEL_ORIGIN: kernelOrigin };
const recordingMessage =
  'Definitions recordings are generated output. Run `bun apps/web/scripts/record.ts definitions-active definitions-release` in the same change as the bundled release update; see the recordings section in apps/web/README.md.';

mock.module('../src/kernel/client.ts', () => ({ requestLocale: () => 'en' }));
mock.module('cloudflare:workers', () => ({ env: workerEnv }));
const { typeFrame } = await import('../src/subject/definitions.ts');

type RecordedRelease = typeof recorded.release;
type TypeDefinition = { bases?: string[]; coverRatio?: string };

test('recorded definitions match the bundled release served by the kernel', () => {
  expect(active.digest, recordingMessage).toBe(bundledDigest);
  expect(recorded.digest, recordingMessage).toBe(bundledDigest);
  expect(recorded.release, recordingMessage).toEqual(bundledRelease);
});

test('recorded release frames work descendants, people, music and recipes through typeFrame', async () => {
  const release = recorded.release as RecordedRelease & { types: Record<string, TypeDefinition> };
  const workDescendants = Object.entries(release.types).filter(
    ([type, definition]) => type !== 'schema:MusicAlbum' && definition.bases?.includes('schema:CreativeWork'),
  );

  expect(workDescendants.length).toBeGreaterThan(0);
  for (const [type, definition] of workDescendants) {
    expect(definition.coverRatio, `${type} should inherit the 5:7 CreativeWork frame`).toBe('5:7');
  }

  const expectedFrames = new Map<string, string>([
    ['schema:CreativeWork', '5:7'],
    ['schema:Book', '5:7'],
    ['schema:TVSeries', '5:7'],
    ['schema:Movie', '5:7'],
    ['schema:VideoGame', '5:7'],
    ['wd:Q689445', '5:7'],
    ['wd:Q95074', '3:4'],
    ['schema:Person', '3:4'],
    ['schema:MusicAlbum', '1:1'],
    ['schema:Recipe', '4:3'],
  ]);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.origin !== kernelOrigin) return originalFetch(input);
    if (url.pathname === '/v1/definitions/active') return Response.json(active);
    if (url.pathname === `/v1/definitions/releases/${encodeURIComponent(active.digest)}`)
      return Response.json(recorded);
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  try {
    for (const [type, definition] of workDescendants) {
      expect(
        (await typeFrame(type, 'en')).ratio,
        `typeFrame(${type}) should resolve its ${definition.coverRatio} frame`,
      ).toBe(definition.coverRatio);
    }
    for (const [type, ratio] of expectedFrames) {
      expect(release.types[type]?.coverRatio, `${type} should have a ${ratio} recorded frame`).toBe(ratio);
      expect((await typeFrame(type, 'en')).ratio, `typeFrame(${type}) should resolve ${ratio}`).toBe(ratio);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
