import tailwindcss from '@tailwindcss/vite';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { build } from 'vite';

const root = join(import.meta.dir, '..');
let stylesheet: Promise<string> | undefined;

async function buildStylesheet() {
  const result = await build({
    root,
    configFile: false,
    logLevel: 'silent',
    plugins: [tailwindcss()],
    build: { write: false, rolldownOptions: { input: join(root, 'src', 'styles.css') } },
  });
  const outputs = Array.isArray(result) ? result : [result];
  for (const output of outputs) {
    if ('output' in output) {
      for (const asset of output.output) {
        if (asset.type === 'asset' && asset.fileName.endsWith('.css')) return asset.source.toString();
      }
    }
  }
  throw new Error('Vite did not produce the UI stylesheet');
}

export type ContrastSample = {
  label: string;
  surface: string;
  ink?: string;
  className?: string;
  hover?: boolean;
};

export async function inspectThemeColors(samples: ContrastSample[], variables: string[] = []) {
  const css = await (stylesheet ??= buildStylesheet());
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 80, height: Math.max(40, 32 * samples.length) } });
    await page.addStyleTag({ content: css });
    await page.addStyleTag({ content: 'body { margin: 0 } [data-swatch] { transition: none !important }' });
    const themes = [];
    const names = [
      ...new Set([...variables, ...samples.flatMap(({ surface, ink }) => (ink ? [surface, ink] : [surface]))]),
    ];
    for (const theme of ['light', 'dark']) {
      await page.mouse.move(79, 0);
      const tokens = await page.evaluate(
        ({ theme, names, samples }) => {
          document.documentElement.className = theme;
          const themeStyle = getComputedStyle(document.documentElement);
          const tokens = Object.fromEntries(
            names.map((name) => {
              const value = themeStyle.getPropertyValue(`--${name}`).trim();
              if (!CSS.supports('color', value)) throw new Error(`${theme} --${name} has no valid color: ${value}`);
              return [name, value];
            }),
          );
          document.body.replaceChildren(
            ...samples.map(({ surface, ink, className }) => {
              const backdrop = document.createElement('div');
              backdrop.style.cssText = `width:64px;height:32px;background-color:var(--${surface})`;
              const swatch = document.createElement('div');
              swatch.dataset.swatch = '';
              swatch.className = className ?? '';
              swatch.style.cssText = 'display:block;position:relative;width:100%;height:100%';
              if (ink) swatch.style.color = `var(--${ink})`;
              // Paint the ink at full pixel coverage while preserving its CSS opacity.
              const foreground = document.createElement('div');
              foreground.style.cssText = 'position:absolute;inset:0 50% 0 0;background-color:currentColor';
              swatch.append(foreground);
              backdrop.append(swatch);
              return backdrop;
            }),
          );
          return tokens;
        },
        { theme, names, samples },
      );
      const capture = async (index?: number) => {
        const clip = { x: 0, y: (index ?? 0) * 32, width: 64, height: index === undefined ? samples.length * 32 : 32 };
        const png = await page.screenshot({ clip });
        return page.evaluate(async (data) => {
          const image = new Image();
          image.src = `data:image/png;base64,${data}`;
          await image.decode();
          const canvas = document.createElement('canvas');
          canvas.width = image.width;
          canvas.height = image.height;
          const context = canvas.getContext('2d')!;
          context.drawImage(image, 0, 0);
          const pixel = (x: number, y: number) => [...context.getImageData(x, y, 1, 1).data].slice(0, 3);
          const weights = [0.2126, 0.7152, 0.0722];
          const luminance = (rgb: number[]) =>
            rgb
              .map((channel) => channel / 255)
              .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
              .reduce((sum, value, channel) => sum + value * weights[channel]!, 0);
          const hex = (rgb: number[]) => `#${rgb.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
          return Array.from({ length: image.height / 32 }, (_, row) => {
            const foreground = pixel(16, row * 32 + 16);
            const background = pixel(48, row * 32 + 16);
            const a = luminance(foreground);
            const b = luminance(background);
            return {
              foreground: hex(foreground),
              background: hex(background),
              ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
            };
          });
        }, png.toString('base64'));
      };
      const contrast = samples.length ? await capture() : [];
      for (const [index, sample] of samples.entries()) {
        if (sample.hover) {
          await page.locator('[data-swatch]').nth(index).hover();
          [contrast[index]!] = await capture(index);
        }
      }
      themes.push({ theme, tokens, contrast });
    }
    return themes;
  } finally {
    await browser.close();
  }
}
