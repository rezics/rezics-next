import { createHash } from 'node:crypto';
import * as tf from '@tensorflow/tfjs';
import { load } from 'nsfwjs/core';
import { MobileNetV2Model } from 'nsfwjs/models/mobilenet_v2';
import sharp from 'sharp';
import { assertStillContainer, verifyImage } from '../media/image.ts';
import { SCREEN_LIMITS, SCREEN_POLICY, type Scores } from './policy.ts';

// libvips processes only one still frame. Animated formats are held: classifying
// one frame cannot clear bytes containing other, unexamined frames.
// Bundled pinned weights are the only admitted model source, even during outages.
globalThis.fetch = (async () => { throw new Error('remote model loading is disabled'); }) as unknown as typeof fetch;
sharp.cache(false);
sharp.concurrency(1);
// One bounded stdin transfer, one validated result over IPC, then process exit.
async function classify(): Promise<void> {
  let model: Awaited<ReturnType<typeof load>> | undefined;
  let tensor: tf.Tensor3D | undefined;
  try {
    const chunks: Uint8Array[] = [];
    let length = 0;
    for await (const chunk of Bun.stdin.stream()) {
      length += chunk.byteLength;
      if (length > SCREEN_LIMITS.bytes) throw new Error('byte bound');
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks, length);
    const mediaType = process.argv[2]!;
    if (!bytes.length || bytes.length > SCREEN_LIMITS.bytes) throw new Error('byte bound');
    const header = verifyImage(bytes, mediaType);
    assertStillContainer(bytes, header.mediaType);
    if (header.width * header.height > SCREEN_LIMITS.pixels) throw new Error('pixel bound');
    const decoder = sharp(bytes, { limitInputPixels: SCREEN_LIMITS.pixels, pages: 1, failOn: 'warning' });
    const metadata = await decoder.metadata();
    if ((metadata.pages ?? 1) !== 1 || !metadata.width || !metadata.height
      || metadata.width > SCREEN_LIMITS.dimension || metadata.height > SCREEN_LIMITS.dimension
      || metadata.width * metadata.height > SCREEN_LIMITS.pixels) throw new Error('frame bound');
    const { data, info } = await decoder.rotate().resize(SCREEN_LIMITS.inputSize, SCREEN_LIMITS.inputSize,
      { fit: 'fill' }).removeAlpha().toColourspace('srgb').raw().timeout({ seconds: 10 }).toBuffer({ resolveWithObject: true });
    if (info.channels !== 3 || data.length !== SCREEN_LIMITS.inputSize ** 2 * 3) throw new Error('pixel shape');
    const hash = createHash('sha256');
    for (const bundle of MobileNetV2Model.weightBundles) hash.update(Buffer.from((await bundle()).default, 'base64'));
    if (hash.digest('hex') !== SCREEN_POLICY.weightsDigest) throw new Error('weight integrity');
    tf.enableProdMode();
    await tf.setBackend('cpu');
    await tf.ready();
    model = await load('MobileNetV2', { modelDefinitions: [MobileNetV2Model] });
    tensor = tf.tensor3d(new Uint8Array(data), [info.height, info.width, 3], 'int32');
    const scores = Object.fromEntries((await model.classify(tensor, 5)).map(item =>
      [item.className, item.probability])) as Scores;
    if (!process.send) throw new Error('missing parent');
    process.send(scores);
  } catch { process.exitCode = 1; }
  finally { tensor?.dispose(); model?.dispose(); }
}
await classify();
process.disconnect?.();
