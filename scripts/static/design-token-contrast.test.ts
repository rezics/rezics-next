import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../../packages/ui/src/styles.css', import.meta.url), 'utf8');
const theme = css.match(/:root,\s*\.dark\s*\{([\s\S]*?)@variant dark\s*\{([\s\S]*?)\n  \}/);
if (!theme) throw new Error('Rezics UI light and dark token blocks are missing');

function color(block: string, name: string): number[] {
  const value = block.match(new RegExp(`--${name}: (#[0-9a-f]{6});`, 'i'))?.[1];
  if (!value) throw new Error(`Missing hex token --${name}`);
  return [1, 3, 5].map(offset => Number.parseInt(value.slice(offset, offset + 2), 16) / 255);
}

function luminance(rgb: number[]): number {
  const linear = rgb.map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

function contrast(a: number[], b: number[]): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter! + 0.05) / (darker! + 0.05);
}

test('Rezics Aura keeps text-safe pairs and a visible brand mark in both themes', () => {
  for (const surface of ['background', 'card']) {
    expect(contrast(color(theme[1]!, 'brand'), color(theme[1]!, surface)))
      .toBeLessThan(4.5);
  }
  for (const block of [theme[1]!, theme[2]!]) {
    const page = color(block, 'background');
    const card = color(block, 'card');
    for (const surface of [page, card]) {
      expect(contrast(color(block, 'foreground'), surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(color(block, 'brand'), surface)).toBeGreaterThanOrEqual(3);
    }
    expect(contrast(color(block, 'primary'), page)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(color(block, 'primary-foreground'), color(block, 'primary'))).toBeGreaterThanOrEqual(4.5);
    for (const tone of ['success', 'info', 'warning', 'destructive']) {
      const fill = color(block, tone);
      const tint = fill.map((channel, index) => channel * 0.1 + card[index]! * 0.9);
      expect(contrast(color(block, `${tone}-foreground`), tint), `${tone} text on a 10% card tint`)
        .toBeGreaterThanOrEqual(4.5);
    }
  }
});
