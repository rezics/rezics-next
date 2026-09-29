import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Resvg } from '@resvg/resvg-js';
import satori from 'satori';

const require = createRequire(import.meta.url);
const font = (weight: 700 | 800) =>
  readFileSync(require.resolve(`@fontsource/manrope/files/manrope-latin-${weight}-normal.woff`));

/** The Z mark from `public/favicon.svg`, in logo red: a non-text mark. */
const mark =
  'M0 571.429 642.857 142.857 571.429 428.571 1000 142.857v285.714L357.143 857.143l71.428-285.714L0 857.143Z';

const h = (type: string, style: Record<string, string | number>, children?: unknown) => ({
  type,
  props: { style, children },
});

/**
 * A 1200x630 share image: mark, wordmark, the page's English name and summary.
 * Latin only on purpose. Share previews of localized pages reuse it; per-locale
 * text would need CJK font slices in the build (see docs/development/about-site.md).
 */
export async function ogImage(title: string, summary: string): Promise<Buffer> {
  const tree = h(
    'div',
    {
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'space-between',
      width: 1200,
      height: 630,
      padding: 72,
      background: '#f9f6f2',
      color: '#2b343d',
      fontFamily: 'Manrope',
    },
    [
      h('div', { display: 'flex', alignItems: 'center' }, [
        {
          type: 'svg',
          props: {
            width: 56,
            height: 40,
            viewBox: '0 142.857 1000 714.286',
            children: { type: 'path', props: { d: mark, fill: '#df3d35' } },
          },
        },
        h('div', { marginLeft: 20, fontSize: 30, fontWeight: 800, letterSpacing: 8 }, 'REZICS'),
      ]),
      h('div', { display: 'flex', flexDirection: 'column' }, [
        h(
          'div',
          {
            fontSize: 84,
            fontWeight: 800,
            letterSpacing: -2.5,
            lineHeight: 1.05,
            color: '#2b343d',
          },
          title,
        ),
        h(
          'div',
          {
            marginTop: 28,
            fontSize: 36,
            fontWeight: 700,
            lineHeight: 1.3,
            color: '#2f63ad',
            maxWidth: 940,
          },
          summary,
        ),
      ]),
    ],
  );
  const svg = await satori(tree as never, {
    width: 1200,
    height: 630,
    fonts: [
      { name: 'Manrope', data: font(700), weight: 700, style: 'normal' },
      { name: 'Manrope', data: font(800), weight: 800, style: 'normal' },
    ],
  });
  return Buffer.from(new Resvg(svg, { fitTo: { mode: 'width', value: 1200 } }).render().asPng());
}
