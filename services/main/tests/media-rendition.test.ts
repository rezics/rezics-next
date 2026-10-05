import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Pool } from 'pg';
import sharp from 'sharp';
import {
  parseProfile,
  pixelCrop,
  renditionProfiles,
  RENDITION_LIMITS,
} from '../src/modules/media-rendition/policy.ts';
import {
  LocalImageTransformer,
  transformInProcess,
} from '../src/modules/media-rendition/transform.ts';
import { MediaRenditionStore } from '../src/modules/media-rendition/store.ts';
import { requestUseRenditions } from '../src/modules/media-rendition/request.ts';
import { MediaRenditionWorker } from '../src/modules/media-rendition/worker.ts';
import { MediaMissing } from '../src/modules/media/store.ts';

test('percent crops round and clamp oriented pixels, rejecting malformed, empty and out-of-frame regions', () => {
  expect(pixelCrop(null, { width: 101, height: 51 })).toEqual({
    left: 0,
    top: 0,
    width: 101,
    height: 51,
  });
  expect(pixelCrop('xywh=percent:10,20,50,60', { width: 101, height: 51 })).toEqual({
    left: 10,
    top: 10,
    width: 51,
    height: 31,
  });
  expect(pixelCrop('xywh=percent:99.999,99.999,0.001,0.001', { width: 101, height: 51 })).toEqual({
    left: 100,
    top: 50,
    width: 1,
    height: 1,
  });
  expect(pixelCrop('xywh=percent:0.1,0.2,99.9,99.8', { width: 101, height: 51 })).toEqual({
    left: 0,
    top: 0,
    width: 101,
    height: 51,
  });
  for (const crop of [
    'xywh=1,2,3,4',
    'xywh=percent:0,0,0,50',
    'xywh=percent:100,0,1,50',
    'xywh=percent:-1,0,50,50',
    'xywh=percent:10,80,50,21',
    'xywh=percent:0,0,101,100',
  ]) {
    expect(() => pixelCrop(crop, { width: 100, height: 100 })).toThrow();
  }
  expect(() => pixelCrop(null, { width: 16_384, height: 16_384 })).toThrow('pixel bound');
});

test('width ladder clips once to the crop, retains both codecs and never asks for upscaling', () => {
  for (const width of [1, 31, 320, 500, 1000, 2560, 16_384]) {
    const profiles = renditionProfiles(width);
    expect(new Set(profiles).size).toBe(profiles.length);
    expect(profiles.length).toBeLessThanOrEqual(RENDITION_LIMITS.candidates);
    expect(
      profiles
        .map((profile) => parseProfile(profile).width)
        .every((candidate) => candidate <= width),
    ).toBe(true);
    expect(profiles.filter((profile) => parseProfile(profile).type === 'image/avif').length).toBe(
      profiles.length / 2,
    );
  }
  expect(renditionProfiles(500)).toEqual([
    'image-width-320-avif-v1',
    'image-width-320-webp-v1',
    'image-width-500-avif-v1',
    'image-width-500-webp-v1',
  ]);
  for (const profile of [
    'image-width-0-webp-v1',
    'image-width-320-jpeg-v1',
    'image-width-2561-avif-v1',
    'image-width-0320-webp-v1',
  ]) {
    expect(() => parseProfile(profile)).toThrow();
  }
});

async function colourBands(width = 128, height = 64, alpha = false): Promise<Buffer> {
  const pixels = Buffer.alloc(width * height * (alpha ? 4 : 3));
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * (alpha ? 4 : 3);
      pixels[offset] = x < width / 2 ? 240 : 0;
      pixels[offset + 2] = x < width / 2 ? 0 : 240;
      if (alpha) pixels[offset + 3] = x < width / 2 ? 0 : 128;
    }
  return sharp(pixels, { raw: { width, height, channels: alpha ? 4 : 3 } })
    .png()
    .toBuffer();
}

test('the real child applies crop after EXIF orientation, strips metadata and does not upscale', async () => {
  const transformer = new LocalImageTransformer();
  const png = await colourBands();
  for (const orientation of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const jpeg = await sharp(png).jpeg({ quality: 100 }).withMetadata({ orientation }).toBuffer();
    expect(await transformer.inspect(jpeg, 'image/jpeg')).toMatchObject(
      orientation >= 5 ? { width: 64, height: 128 } : { width: 128, height: 64 },
    );
  }
  const jpeg = await sharp(png).jpeg({ quality: 100 }).withMetadata({ orientation: 6 }).toBuffer();
  const output = await transformer.transform(jpeg, 'image/jpeg', {
    profile: 'image-width-320-webp-v1',
    crop: 'xywh=percent:0,0,100,50',
  });
  expect(output).toMatchObject({ width: 64, height: 64, type: 'image/webp' });
  const metadata = await sharp(output.bytes).metadata();
  expect(metadata.orientation).toBeUndefined();
  expect(metadata.exif).toBeUndefined();
  const { data } = await sharp(output.bytes)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  expect(data[0]).toBeGreaterThan(200);
  expect(data[2]).toBeLessThan(30);
  const mirrored = await sharp(png)
    .jpeg({ quality: 100 })
    .withMetadata({ orientation: 2 })
    .toBuffer();
  const mirrorOutput = await transformer.transform(mirrored, 'image/jpeg', {
    profile: 'image-width-64-webp-v1',
    crop: 'xywh=percent:0,0,50,100',
  });
  const mirrorPixels = await sharp(mirrorOutput.bytes).raw().toBuffer();
  expect(mirrorPixels[0]).toBeLessThan(30);
  expect(mirrorPixels[2]).toBeGreaterThan(200);
}, 20_000);

test('AVIF and WebP preserve transparent and translucent logo/cutout pixels while resizing', async () => {
  const transformer = new LocalImageTransformer();
  const png = await colourBands(128, 64, true);
  for (const codec of ['avif', 'webp']) {
    const output = await transformer.transform(png, 'image/png', {
      profile: `image-width-64-${codec}-v1`,
      crop: null,
    });
    expect(output).toMatchObject({ width: 64, height: 32, type: `image/${codec}` });
    expect((await sharp(output.bytes).metadata()).hasAlpha).toBe(true);
    const pixels = await sharp(output.bytes).ensureAlpha().raw().toBuffer();
    expect(pixels[3]).toBe(0);
    expect(pixels[63 * 4 + 3]).toBeGreaterThanOrEqual(126);
    expect(pixels[63 * 4 + 3]).toBeLessThanOrEqual(130);
  }
}, 10_000);

test('real child rejects corrupt containers, animations, excess pixels, byte caps and deadlines', async () => {
  const transformer = new LocalImageTransformer();
  const png = await colourBands(32, 32);
  const plan = { profile: 'image-width-32-webp-v1', crop: null };
  await expect(
    transformer.transform(new Uint8Array([1, 2, 3]), 'image/png', plan),
  ).rejects.toThrow();
  await expect(transformer.transform(png, 'image/jpeg', plan)).rejects.toThrow();
  await expect(
    transformer.transform(new Uint8Array(RENDITION_LIMITS.bytes + 1), 'image/png', plan),
  ).rejects.toThrow();
  await expect(new LocalImageTransformer(1).transform(png, 'image/png', plan)).rejects.toThrow();
  const control = Buffer.alloc(20);
  control.writeUInt32BE(8);
  control.write('acTL', 4);
  control.writeUInt32BE(2, 8);
  await expect(
    transformer.inspect(
      Buffer.concat([png.subarray(0, 33), control, png.subarray(33)]),
      'image/png',
    ),
  ).rejects.toThrow();
  const largeHeader = new Uint8Array(png);
  new DataView(largeHeader.buffer).setUint32(16, 16_384);
  new DataView(largeHeader.buffer).setUint32(20, 16_384);
  await expect(transformer.inspect(largeHeader, 'image/png')).rejects.toThrow();
}, 10_000);

test('fatal, unresponsive and aborted transform children exit without killing Main or leaving a decoder', async () => {
  const root = resolve(import.meta.dir, '../../../.temp');
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'media-rendition-process-'));
  try {
    for (const mode of ['fatal', 'deadline', 'abort'] as const) {
      const pidFile = join(directory, `${mode}.pid`);
      const script = join(directory, `${mode}.ts`);
      writeFileSync(
        script,
        `await Bun.write(${JSON.stringify(pidFile)}, String(process.pid));
        ${mode === 'fatal' ? "process.kill(process.pid, 'SIGKILL');" : 'while (true) {}'}`,
      );
      const controller = new AbortController();
      const result = transformInProcess(
        new Uint8Array([1]),
        'image/png',
        null,
        2000,
        controller.signal,
        pathToFileURL(script),
      ).then(
        () => null,
        (error: Error) => error,
      );
      let pid = 0;
      for (let attempt = 0; attempt < 100 && !pid; attempt++) {
        try {
          pid = Number(readFileSync(pidFile, 'utf8'));
        } catch {
          await Bun.sleep(5);
        }
      }
      expect(pid).toBeGreaterThan(0);
      expect(pid).not.toBe(process.pid);
      if (mode === 'abort') controller.abort();
      expect((await result)?.message).toBe('local image transform unavailable');
      expect(() => process.kill(pid, 0)).toThrow();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 10_000);

test('empty, invalid and oversized candidate batches do not reach PostgreSQL; duplicates use one query', async () => {
  let queries = 0;
  const use = randomUUID();
  const store = new MediaRenditionStore({
    query: async (_sql: string, params: unknown[]) => {
      queries++;
      expect(params).toEqual([[use]]);
      return { rows: [] };
    },
  } as unknown as Pool);
  expect(await store.candidatesBatch([])).toEqual(new Map());
  await expect(store.candidatesBatch(['invalid'])).rejects.toThrow();
  await expect(store.candidatesBatch(Array(65).fill(use))).rejects.toThrow();
  expect(queries).toBe(0);
  expect(await store.candidatesBatch([use, use])).toEqual(new Map([[use, []]]));
  expect(queries).toBe(1);
});

test('source integrity and unavailable Uses queue no jobs, and a worker deadline aborts pending decoding', async () => {
  let queued = 0;
  const store = {
    requestBasis: async () => ({ use: randomUUID(), digest: '0'.repeat(64), namespace: 'media/' }),
    queue: async () => {
      queued++;
      return 1;
    },
  } as unknown as MediaRenditionStore;
  await expect(
    requestUseRenditions(
      store,
      () => ({
        get: async () => new Uint8Array([1]),
        put: async () => {
          throw new Error('must not put');
        },
      }),
      randomUUID(),
    ),
  ).rejects.toThrow('integrity');
  expect(queued).toBe(0);
  const unavailable = new MediaRenditionStore({
    query: async () => ({ rows: [] }),
  } as unknown as Pool);
  await expect(unavailable.requestBasis(randomUUID())).rejects.toBeInstanceOf(MediaMissing);
  let aborted = false;
  const bytes = new Uint8Array([1]);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const worker = new MediaRenditionWorker(
    {
      leaseCrop: async () => [{ digest, namespace: 'media/' }],
      settle: async () => {
        throw new Error('must not settle');
      },
    } as unknown as MediaRenditionStore,
    {
      inspect: async () => {
        throw new Error('unused');
      },
      transform: async () => {
        throw new Error('unused');
      },
      transformCrop: async (_bytes, _type, _plans, signal) =>
        new Promise((_resolve, reject) =>
          signal?.addEventListener(
            'abort',
            () => {
              aborted = true;
              reject(new Error('aborted'));
            },
            { once: true },
          ),
        ),
    },
    () => ({
      get: async () => bytes,
      put: async () => {
        throw new Error('must not put');
      },
    }),
    10,
  );
  await worker.tick();
  expect(aborted).toBe(true);
});

test('one crop transform writes every clipped width and codec from one materialized source decode', async () => {
  const transformer = new LocalImageTransformer();
  const bytes = await colourBands(800, 400, true);
  const plans = renditionProfiles(400).map((profile) => ({
    profile,
    crop: 'xywh=percent:50,0,50,100',
  }));
  const outputs = await transformer.transformCrop(bytes, 'image/png', plans);
  expect(outputs.map((output) => [output.width, output.height, output.type])).toEqual([
    [320, 320, 'image/avif'],
    [320, 320, 'image/webp'],
    [400, 400, 'image/avif'],
    [400, 400, 'image/webp'],
  ]);
  for (const output of outputs) {
    const pixels = await sharp(output.bytes).ensureAlpha().raw().toBuffer();
    expect(pixels[0]).toBeLessThan(30);
    expect(pixels[2]).toBeGreaterThan(200);
    expect(pixels[3]).toBeGreaterThanOrEqual(126);
    expect(pixels[3]).toBeLessThanOrEqual(130);
  }
  await expect(
    transformer.transformCrop(bytes, 'image/png', [plans[0]!, { ...plans[1]!, crop: null }]),
  ).rejects.toThrow('plans');
}, 15_000);

test('one worker tick fetches and transforms a crop once and persists all its leased profiles', async () => {
  const bytes = new Uint8Array([1]);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const leases = renditionProfiles(640).map((profile) => ({
    profile,
    crop: null,
    digest,
    namespace: 'media/',
  }));
  let gets = 0,
    decodes = 0,
    puts = 0,
    settled = 0;
  const outputs = leases.map((lease) => ({
    bytes,
    width: parseProfile(lease.profile).width,
    height: 1,
    type: parseProfile(lease.profile).type,
  }));
  const worker = new MediaRenditionWorker(
    {
      leaseCrop: async () => leases,
      settle: async (lease: unknown, output: unknown, persist: () => Promise<string>) => {
        expect(lease).toBe(leases[settled]);
        expect(output).toBe(outputs[settled++]);
        await persist();
        return true;
      },
    } as unknown as MediaRenditionStore,
    {
      inspect: async () => {
        throw new Error('unused');
      },
      transform: async () => {
        throw new Error('must not decode each profile');
      },
      transformCrop: async (_bytes, _type, plans) => {
        decodes++;
        expect(plans).toEqual(leases.map(({ profile, crop }) => ({ profile, crop })));
        return outputs;
      },
    },
    () => ({
      get: async () => {
        gets++;
        return bytes;
      },
      put: async () => {
        puts++;
        return digest;
      },
    }),
  );
  await worker.tick();
  expect({ gets, decodes, puts, settled }).toEqual({ gets: 1, decodes: 1, puts: 4, settled: 4 });
});
