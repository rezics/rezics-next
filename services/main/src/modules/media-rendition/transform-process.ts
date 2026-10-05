import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { assertStillContainer, verifyImage } from '../media/image.ts';
import {
  checkSize,
  parseProfile,
  pixelCrop,
  RENDITION_LIMITS,
  type RenditionPlan,
} from './policy.ts';

sharp.cache(false);
sharp.concurrency(1);
// No object credentials enter this process: bounded stdin, one IPC report and
// bounded stdout bytes are its entire protocol. Native work dies with the child.
async function transform(): Promise<void> {
  try {
    const chunks: Uint8Array[] = [];
    let length = 0;
    for await (const chunk of Bun.stdin.stream()) {
      length += chunk.byteLength;
      if (length > RENDITION_LIMITS.bytes) throw new Error('rendition byte bound');
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks, length);
    const header = verifyImage(bytes, process.argv[2]!);
    checkSize(header);
    assertStillContainer(bytes, header.mediaType);
    const decoder = sharp(bytes, {
      pages: 1,
      limitInputPixels: RENDITION_LIMITS.pixels,
      failOn: 'warning',
    });
    const metadata = await decoder.metadata();
    if ((metadata.pages ?? 1) !== 1) throw new Error('rendition requires a still frame');
    const size = metadata.autoOrient;
    checkSize(size);
    if (!process.send) throw new Error('missing rendition parent');
    const plan = JSON.parse(process.argv[3]!) as RenditionPlan | null;
    if (plan === null) {
      process.send({ ...size, hasAlpha: metadata.hasAlpha, type: null, byteLength: 0, sha256: null });
      return;
    }
    const profile = parseProfile(plan.profile);
    const region = pixelCrop(plan.crop, size);
    let pipeline = decoder
      .autoOrient()
      .extract(region)
      .resize({ width: profile.width, withoutEnlargement: true });
    // Both codecs retain alpha; no flatten/removeAlpha or metadata copy occurs.
    pipeline =
      profile.type === 'image/avif'
        ? pipeline.avif({ quality: 60, effort: 3, chromaSubsampling: '4:4:4' })
        : pipeline.webp({ quality: 80, alphaQuality: 100, effort: 3 });
    const { data, info } = await pipeline
      .timeout({ seconds: 25 })
      .toBuffer({ resolveWithObject: true });
    checkSize(info);
    if (!data.length || data.length > RENDITION_LIMITS.bytes || info.width > region.width)
      throw new Error('rendition output bound');
    process.send({
      width: info.width,
      height: info.height,
      hasAlpha: metadata.hasAlpha,
      type: profile.type,
      byteLength: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
    });
    await Bun.write(Bun.stdout, data);
  } catch {
    process.exitCode = 1;
  }
}
await transform();
process.disconnect?.();
