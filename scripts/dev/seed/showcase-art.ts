import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { ShowcaseRoleKey, ShowcaseWork } from './showcase-plan.ts';

const art = new URL('../../../apps/web/features/showcase/art/', import.meta.url);

/** Admission minimums: landscape 16:9 from 1280×720, portrait 3:4 from 960×1280. */
export const sizes = {
  'background-landscape': { width: 1600, height: 900 },
  'background-portrait': { width: 960, height: 1280 },
  cutout: { width: 420, height: 700 },
  logo: { width: 600, height: 200 },
} as const;

/** Where the fixture art's subject lies, as `xywh=percent:` on the whole image. */
export const focal = {
  'background-landscape': 'xywh=percent:63,25,18,45',
  'background-portrait': 'xywh=percent:56,25,23,40',
} as const;
export const wholeImage = 'xywh=percent:0,0,100,100';

const file = (key: ShowcaseRoleKey) => key.role === 'logo' ? `logo-${key.language}-${key.tone}.svg`
  : key.role === 'cutout' ? 'cutout.svg' : key.role === 'background-portrait' ? 'portrait.svg' : 'landscape.svg';

/** The wordmark carries the Work's own name in the language of its logo, sized to fit the plate. */
export function logoSvg(svg: string, name: string, language: 'en' | 'ja'): string {
  const wide = language === 'en' ? 0.62 : 1.05;
  const size = Math.min(language === 'en' ? 70 : 78, Math.floor(520 / (Math.max(name.length, 1) * wide)));
  return svg.replace(/(<text[^>]*?)font-size="\d+"([^>]*>)[^<]*(<\/text>)/,
    (_, open: string, close: string, end: string) => `${open}font-size="${size}"${close}${name}${end}`);
}

/** A PNG of the fixture at the size the role needs, hue-shifted so each Work looks like its own. */
export async function renderArt(work: ShowcaseWork, key: ShowcaseRoleKey): Promise<Uint8Array> {
  const { width, height } = sizes[key.role];
  const source = await Bun.file(new URL(file(key), art)).text();
  const svg = key.role === 'logo' ? logoSvg(source, work.names[key.language], key.language) : source;
  const natural = Number(/<svg[^>]*\swidth="(\d+)"/.exec(svg)?.[1]);
  const image = sharp(Buffer.from(svg), { density: Math.ceil(72 * Math.max(1, width / natural)) })
    .resize(width, height, { fit: 'fill' });
  const toned = key.role === 'logo' ? image : image.modulate({ hue: work.hue });
  return new Uint8Array(await toned.png().toBuffer());
}

export const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
