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
    const plans = JSON.parse(process.argv[3]!) as RenditionPlan[] | null;
    if (plans === null) {
      process.send([
        { ...size, hasAlpha: metadata.hasAlpha, type: null, byteLength: 0, sha256: null },
      ]);
      return;
    }
    if (
      !plans.length ||
      plans.length > RENDITION_LIMITS.candidates ||
      plans.some((plan) => plan.crop !== plans[0]!.crop)
    )
      throw new Error('invalid rendition plans');
    const region = pixelCrop(plans[0]!.crop, size);
    // Materialize oriented crop pixels once. Cloning a compressed-input pipeline
    // would decode again for every output; raw input makes that impossible.
    const decoded = await decoder
      .autoOrient()
      .extract(region)
      .raw()
      .timeout({ seconds: 25 })
      .toBuffer({ resolveWithObject: true });
    const reports = [];
    for (const plan of plans) {
      const profile = parseProfile(plan.profile);
      let pipeline = sharp(decoded.data, { raw: decoded.info }).resize({
        width: profile.width,
        withoutEnlargement: true,
      });
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
      reports.push({
        width: info.width,
        height: info.height,
        hasAlpha: metadata.hasAlpha,
        type: profile.type,
        byteLength: data.length,
        sha256: createHash('sha256').update(data).digest('hex'),
      });
      await Bun.write(Bun.stdout, data);
    }
    process.send(reports);
  } catch {
    process.exitCode = 1;
  }
}
await transform();
process.disconnect?.();
