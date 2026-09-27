// Color arithmetic for Zone themes: WCAG 2 contrast on sRGB, and lightness
// changes in OKLCH so a derived tone keeps the accent's hue.

/** sRGB channels in 0..1. */
export type Rgb = readonly [number, number, number];

export function parseHex(hex: string): Rgb {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) throw new Error(`Not a #rrggbb color: ${hex}`);
  const value = Number.parseInt(match[1]!, 16);
  return [(value >> 16 & 255) / 255, (value >> 8 & 255) / 255, (value & 255) / 255];
}

export function toHex(rgb: Rgb): string {
  return `#${rgb.map(channel => Math.round(Math.min(1, Math.max(0, channel)) * 255)
    .toString(16).padStart(2, '0')).join('')}`;
}

const linear = (channel: number) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
const gamma = (channel: number) => channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055;

/** WCAG relative luminance. */
export function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map(linear) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, 1–21. */
export function contrast(a: Rgb, b: Rgb): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

type Lab = readonly [number, number, number];

function toOklab(rgb: Rgb): Lab {
  const [r, g, b] = rgb.map(linear) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

/** Unclamped: a channel outside 0..1 means the color is outside sRGB. */
function fromOklab([L, a, b]: Lab): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [gamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    gamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    gamma(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)];
}

const inGamut = (rgb: Rgb) => rgb.every(channel => channel >= -1e-4 && channel <= 1 + 1e-4);

/** The color at OKLCH lightness `L` with the source hue, its chroma reduced until it fits sRGB. */
function atLightness(source: Lab, L: number): Rgb {
  let [, a, b] = source;
  for (let step = 0; step < 60; step += 1) {
    const rgb = fromOklab([L, a, b]);
    if (inGamut(rgb)) return rgb;
    a *= 0.92;
    b *= 0.92;
  }
  return fromOklab([L, 0, 0]);
}

/** Mixes `amount` (0..1) of `a` into `b` in OKLab, as CSS `color-mix(in oklab, a amount, b)` does. */
export function mix(a: Rgb, amount: number, b: Rgb): Rgb {
  const x = toOklab(a);
  const y = toOklab(b);
  return fromOklab([0, 1, 2].map(index => x[index]! * amount + y[index]! * (1 - amount)) as unknown as Lab)
    .map(channel => Math.min(1, Math.max(0, channel))) as unknown as Rgb;
}

/**
 * The accent's hue at the lightness nearest its own that reaches `target`
 * contrast on every surface, moving darker on light surfaces and lighter on
 * dark ones. Pure black or white always qualifies, so this always returns.
 */
export function readableOn(accent: Rgb, surfaces: readonly Rgb[], target = 4.5): Rgb {
  if (surfaces.every(surface => contrast(accent, surface) >= target)) return accent;
  const lab = toOklab(accent);
  const lighter = surfaces.reduce((sum, surface) => sum + luminance(surface), 0) / surfaces.length < 0.2;
  for (let step = 1; step <= 100; step += 1) {
    const L = lighter ? lab[0] + (1 - lab[0]) * step / 100 : lab[0] * (1 - step / 100);
    const candidate = atLightness(lab, L);
    if (surfaces.every(surface => contrast(candidate, surface) >= target)) return candidate;
  }
  return lighter ? [1, 1, 1] : [0, 0, 0];
}

const white: Rgb = [1, 1, 1];

/** Text on a filled `background`: white, or the given dark ink when that reads better. */
export function inkOn(background: Rgb, dark: Rgb): Rgb {
  return contrast(white, background) >= contrast(dark, background) ? white : dark;
}
