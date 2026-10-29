import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Cover,
  coverRatio,
  placeholderColors,
  sharedRatio,
  type CoverRatio,
  type CoverSize,
  type CoverSubject,
  type CoverSummary,
} from '../src/components/cover.tsx';

const root = join(import.meta.dir, '..');
const stories = 'src/components/cover.stories.tsx';
const sizes: CoverSize[] = ['xs', 'sm', 'md', 'lg', 'xl', 'fill'];
const widths = { xs: 48, sm: 96, md: 160, lg: 240, xl: 320 } as const;

const book: CoverSubject = {
  id: '0192-book',
  title: 'The Wind-Up Bird Chronicle',
  types: ['schema:Book', 'schema:CreativeWork', 'schema:Thing'],
  byline: 'Haruki Murakami',
};
const person: CoverSubject = { id: '0192-person', title: 'Kaori Miyazono', types: ['wd:Q95074', 'schema:Thing'] };

const summary = (overrides: Partial<CoverSummary> = {}): CoverSummary => ({
  media: 'm1',
  width: 1200,
  height: 1800,
  placeholder: { thumbhash: '3PcNNYSFeXh/b4B8d3h4eoiHCHxIB3AA', color: '#5a4632' },
  variants: [
    { format: 'avif', width: 320 },
    { format: 'avif', width: 640 },
    { format: 'webp', width: 320 },
    { format: 'webp', width: 640 },
  ],
  focalPoint: null,
  credit: {
    rightsHolder: 'Shinchosha',
    via: { name: 'Open Library', url: 'https://openlibrary.org/' },
    license: 'All rights reserved',
  },
  ...overrides,
});

const src = (media: string, format: 'avif' | 'webp', width: number) => `/media/${media}.${format}?w=${width}`;

type Props = Omit<Parameters<typeof Cover>[0], 'src' | 'size'> & { size?: CoverSize };
const render = (props: Props) => renderToStaticMarkup(createElement(Cover, { size: 'md', src, ...props }));
const tag = (html: string, name: string) => html.match(new RegExp(`<${name}\\b[^>]*>`))?.[0] ?? '';
const attr = (element: string, name: string) =>
  element.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1]?.replaceAll('&amp;', '&');

const channel = (value: number) => {
  const unit = value / 255;
  return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex: string) => {
  const [red, green, blue] = [1, 3, 5].map((start) => channel(Number.parseInt(hex.slice(start, start + 2), 16)));
  return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
};
const contrast = (first: string, second: string) => {
  const [light, dark] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (light! + 0.05) / (dark! + 0.05);
};

let storyRun: Promise<string[]> | undefined;
/** Runs the cover stories once in the browser project and returns each story's outcome. */
function storyOutcomes(): Promise<string[]> {
  storyRun ??= (async () => {
    expect(existsSync(join(root, stories)), stories).toBe(true);
    const output = mkdtempSync(join(tmpdir(), 'rezics-ui-cover-'));
    const report = join(output, 'stories.json');
    try {
      const run = Bun.spawn(['bun', 'x', 'vitest', 'run', '--reporter=json', `--outputFile=${report}`, stories], {
        cwd: root,
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, CI: '1' },
      });
      const [stdout, stderr] = await Promise.all([
        new Response(run.stdout).text(),
        new Response(run.stderr).text(),
        run.exited,
      ]);
      expect(existsSync(report), `${stdout.slice(-2000)}\n${stderr.slice(-4000)}`).toBe(true);
      const result = JSON.parse(readFileSync(report, 'utf8')) as {
        testResults: { assertionResults: { status: string; title: string; failureMessages: string[] }[] }[];
      };
      return result.testResults
        .flatMap((file) => file.assertionResults)
        .map((assertion) =>
          `${assertion.title}: ${assertion.status} ${assertion.failureMessages[0]?.split('\n')[0] ?? ''}`.trim(),
        )
        .sort();
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  })();
  return storyRun;
}

/** Every story passes, and the named ones exist: they drive load, error, reveal and the credit in a browser. */
async function expectStories(names: string[]) {
  const outcomes = await storyOutcomes();
  expect(outcomes.filter((outcome) => !outcome.includes(': passed'))).toEqual([]);
  for (const name of names) expect(outcomes, name).toContain(`${name}: passed`);
}

test('a directly supplied invalid frame ratio falls back to the subject type', () => {
  for (const ratio of ['0:1', '65:1', '1.5:2', 'portrait'] as CoverRatio[]) {
    expect(attr(tag(render({ subject: book, cover: null, ratio }), 'div'), 'data-ratio')).toBe('5:7');
    expect(attr(tag(render({ subject: person, cover: null, ratio }), 'div'), 'data-ratio')).toBe('3:4');
  }
});

test('the cover frame keeps its type’s ratio and named size before the image loads, after it loads and when it fails', async () => {
  const expected: [CoverSubject, CoverRatio][] = [
    [book, '5:7'],
    [person, '3:4'],
    [{ id: 'album', title: 'Kind of Blue', types: ['schema:MusicAlbum'] }, '1:1'],
    [{ id: 'recipe', title: 'Miso soup', types: ['schema:Recipe'] }, '4:3'],
  ];
  for (const [subject, ratio] of expected) {
    for (const size of sizes) {
      // Without a cover, with a cover still loading, and with a ratio set by the row.
      for (const cover of [null, summary()]) {
        const html = render({ subject, cover, size });
        const frame = tag(html, 'div');
        expect(attr(frame, 'data-ratio'), `${subject.id} ${size}`).toBe(ratio);
        expect(attr(frame, 'data-size')).toBe(size);
        if (size === 'fill') expect(attr(frame, 'style')).toContain('width:100%');
        else expect(attr(frame, 'style')).toContain(`width:${widths[size]}px`);
        expect(html).toContain(`--ratio:${Number(ratio.split(':')[0]) / Number(ratio.split(':')[1])}`);
      }
    }
  }
  expect(attr(tag(render({ subject: book, cover: summary() }), 'div'), 'data-state')).toBe('loading');
  expect(attr(tag(render({ subject: book, cover: null }), 'div'), 'data-state')).toBe('placeholder');
  expect(attr(tag(render({ subject: book, cover: null, ratio: '1:1' }), 'div'), 'data-ratio')).toBe('1:1');
  expect(coverRatio(['schema:Book', 'schema:CreativeWork'])).toBe('5:7');
  expect(coverRatio(['bf:Instance', 'schema:CreativeWork'])).toBe('5:7');
  expect(coverRatio(['schema:TVSeries'])).toBe('5:7');
  expect(coverRatio(['schema:Movie'])).toBe('5:7');
  expect(coverRatio(['wd:Q689445'])).toBe('5:7');
  expect(coverRatio(['schema:VideoGame', 'schema:CreativeWork'])).toBe('5:7');
  expect(coverRatio(['schema:MusicAlbum', 'schema:CreativeWork'])).toBe('1:1');
  expect(coverRatio(['schema:Recipe'])).toBe('4:3');
  expect(coverRatio(['schema:Person'])).toBe('3:4');
  expect(coverRatio(['wd:Q95074'])).toBe('3:4');
  expect(coverRatio(['schema:Organization'])).toBe('1:1');
  expect(coverRatio(['schema:CreativeWorkSeries', 'schema:CreativeWork'])).toBe('5:7');
  expect(coverRatio(['schema:Thing'])).toBe('1:1');
  expect(coverRatio([])).toBe('1:1');
  // The browser measures the frame before the image loads, after it loads and after it fails.
  await expectStories(['Frame Keeps Size']);
}, 300_000);

test('a missing, failed or taken-down cover renders the title and byline from 64 px and an image icon below', async () => {
  for (const size of ['sm', 'md', 'lg', 'xl'] as const) {
    const html = render({ subject: book, cover: null, size });
    expect(html).toContain('The Wind-Up Bird Chronicle');
    expect(html).toContain('Haruki Murakami');
    expect(html).not.toContain('<svg');
    expect(html).not.toContain('<img');
    // The title uses the Work title face and the byline the interface face.
    expect(html).toMatch(/font-work-title[^>]*>The Wind-Up Bird Chronicle</);
    expect(html).toMatch(/font-sans[^>]*>Haruki Murakami</);
  }
  // A summary with no variants has nothing to show: the same placeholder.
  const empty = render({ subject: book, cover: summary({ variants: [] }) });
  expect(empty).toContain('Haruki Murakami');
  expect(empty).not.toContain('<img');
  // A title with long CJK text keeps the title, and the byline is optional.
  const cjk = render({
    subject: { id: 'cjk', title: '吾輩は猫である 夏目漱石全集 第一巻', types: ['schema:Book'] },
    cover: null,
  });
  expect(cjk).toContain('吾輩は猫である 夏目漱石全集 第一巻');
  // Below 64 px the placeholder shows a neutral image icon, with the title as its accessible name.
  const small = render({ subject: book, cover: null, size: 'xs' });
  expect(small).toContain('data-slot="cover-placeholder-icon"');
  expect(small).not.toContain('>TW<');
  expect(small).toContain('aria-label="The Wind-Up Bird Chronicle"');
  expect(small).toContain('<svg');
  // A failed or taken-down image is the same placeholder: the story harness drives the error.
  await expectStories(['Image Fails', 'States']);
}, 300_000);

test('the same subject always gets the same placeholder colour, and its text stays legible in both themes and at xs', () => {
  const first = placeholderColors(book);
  expect(placeholderColors({ ...book })).toEqual(first);
  expect(placeholderColors({ ...book, title: 'Another title', byline: undefined })).toEqual(first);
  const markup = (size: CoverSize) => render({ subject: book, cover: null, size });
  for (const size of sizes) {
    expect(markup(size)).toContain(`background-color:${first.background}`);
    expect(markup(size)).toContain(`color:${first.foreground}`);
    // The colours are fixed, not themed, so they hold in light and dark.
    expect(markup(size)).not.toContain('dark:');
  }
  const families = [
    ['schema:Book'],
    ['schema:VideoGame'],
    ['schema:MusicAlbum'],
    ['schema:Recipe'],
    ['schema:Person'],
    ['schema:Organization'],
    ['schema:Thing'],
  ];
  const seen = new Set<string>();
  for (const types of families) {
    for (let index = 0; index < 400; index++) {
      const colors = placeholderColors({ id: `subject-${index}`, title: 'T', types });
      seen.add(colors.background);
      expect(contrast(colors.foreground, colors.background), `${types[0]} ${colors.background}`).toBeGreaterThanOrEqual(
        4.5,
      );
    }
  }
  // The palette gives variety: different subjects do not all share one colour.
  expect(seen.size).toBeGreaterThan(8);
  const backgrounds = new Set(
    Array.from(
      { length: 60 },
      (_, index) => placeholderColors({ id: `b${index}`, title: 'T', types: ['schema:Book'] }).background,
    ),
  );
  expect(backgrounds.size).toBeGreaterThan(3);
});

test('variants become a picture with AVIF before WebP, a srcset of the returned widths and sizes from the named size', () => {
  const html = render({ subject: book, cover: summary(), size: 'md' });
  const picture = html.slice(html.indexOf('<picture'), html.indexOf('</picture>'));
  const sources = [...picture.matchAll(/<source\b[^>]*>/g)].map((match) => match[0]);
  expect(sources).toHaveLength(2);
  expect(attr(sources[0]!, 'type')).toBe('image/avif');
  expect(attr(sources[1]!, 'type')).toBe('image/webp');
  expect(attr(sources[0]!, 'srcSet')).toBe('/media/m1.avif?w=320 320w, /media/m1.avif?w=640 640w');
  expect(attr(sources[1]!, 'srcSet')).toBe('/media/m1.webp?w=320 320w, /media/m1.webp?w=640 640w');
  expect(attr(sources[0]!, 'sizes')).toBe('160px');
  const image = tag(picture, 'img');
  expect(attr(image, 'srcSet')).toBe(attr(sources[1]!, 'srcSet'));
  expect(attr(image, 'src')).toBe('/media/m1.webp?w=640');
  expect(attr(image, 'width')).toBe('160');
  expect(attr(image, 'height')).toBe('224');
  for (const size of ['xs', 'sm', 'md', 'lg', 'xl'] as const) {
    expect(attr(tag(render({ subject: book, cover: summary(), size }), 'source'), 'sizes')).toBe(`${widths[size]}px`);
  }
  expect(attr(tag(render({ subject: book, cover: summary(), size: 'fill' }), 'source'), 'sizes')).toBe('100vw');
  // Only the formats the kernel returned are offered, and the site builds every address.
  const webpOnly = render({ subject: book, cover: summary({ variants: [{ format: 'webp', width: 320 }] }) });
  expect(webpOnly).not.toContain('image/avif');
  expect(webpOnly).toContain('/media/m1.webp?w=320 320w');
  expect(attr(tag(webpOnly, 'img'), 'src')).toBe('/media/m1.webp?w=320');
});

test('an image within 15% of the frame ratio fills it, a wider or taller one is shown whole on its placeholder colour, and portraits keep their top', () => {
  const fit = (cover: CoverSummary, subject: CoverSubject = book) => {
    const html = render({ subject, cover });
    return { html, frame: tag(html, 'div'), image: tag(html, 'img') };
  };
  for (const [width, height] of [
    [1200, 1800],
    [1000, 1500],
    [740, 1000],
    [760, 1000],
    [800, 1000],
  ] as const) {
    const { frame, image } = fit(summary({ width, height }));
    expect(attr(image, 'class'), `${width}x${height}`).toContain('object-cover');
    expect(attr(frame, 'data-fit')).toBe('cover');
  }
  for (const [width, height] of [
    [1800, 1200],
    [1000, 1000],
    [500, 1000],
    [600, 1000],
  ] as const) {
    const { html, frame, image } = fit(summary({ width, height }));
    expect(attr(image, 'class'), `${width}x${height}`).toContain('object-contain');
    expect(attr(frame, 'data-fit')).toBe('contain');
    // The backdrop is the cover's own placeholder colour.
    expect(html).toContain('background-color:#5a4632');
  }
  // A square album in a portrait slot is shown whole; a portrait person keeps the top when cropped.
  expect(attr(fit(summary({ width: 1000, height: 1000 })).image, 'class')).toContain('object-contain');
  const portrait = fit(summary({ width: 900, height: 1200 }), person);
  expect(attr(portrait.image, 'style')).toContain('object-position:top');
  const tall = fit(summary({ width: 780, height: 1000 }), person);
  expect(attr(tall.image, 'class')).toContain('object-cover');
  expect(attr(tall.image, 'style')).toContain('object-position:top');
  // Other images keep their stored focal point, or the centre.
  expect(attr(fit(summary({ focalPoint: { x: 0.25, y: 0.75 } })).image, 'style')).toContain('object-position:25% 75%');
  expect(attr(fit(summary()).image, 'style')).toContain('object-position:50% 50%');
});

test('a cover withheld for suitability is blurred behind a label and a reveal control unless the viewer shows such covers', async () => {
  const withheld = summary({ withheld: 'suitability' });
  for (const suitability of [undefined, 'blur' as const]) {
    const html = render({ subject: book, cover: withheld, suitability });
    const frame = tag(html, 'div');
    expect(attr(frame, 'data-state')).toBe('withheld');
    expect(html).toContain('Sensitive cover');
    expect(html).toContain('<button');
    expect(html).toContain('Show cover');
    expect(html).toContain('blur');
    // No image byte is requested until the viewer reveals it.
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<picture');
  }
  const shown = render({ subject: book, cover: withheld, suitability: 'show' });
  expect(shown).toContain('<img');
  expect(shown).not.toContain('<button');
  expect(shown).not.toContain('Sensitive cover');
  // The labels can be localized by the site.
  expect(render({ subject: book, cover: withheld, labels: { withheld: '敏感封面', reveal: '顯示封面' } })).toContain(
    '顯示封面',
  );
  // A reveal in the browser shows the image.
  await expectStories(['Withheld Reveal']);
}, 300_000);

test('a decorative repeat has empty alt text, the page cover loads eagerly with high priority and others lazily', () => {
  const alt = (props: Props) => attr(tag(render({ subject: book, cover: summary(), ...props }), 'img'), 'alt');
  expect(alt({})).toBe('The Wind-Up Bird Chronicle');
  expect(alt({ decorative: true })).toBe('');
  const page = tag(render({ subject: book, cover: summary(), priority: true }), 'img');
  expect(attr(page, 'loading')).toBe('eager');
  expect(attr(page, 'fetchPriority')).toBe('high');
  const other = tag(render({ subject: book, cover: summary() }), 'img');
  expect(attr(other, 'loading')).toBe('lazy');
  expect(attr(other, 'fetchPriority')).not.toBe('high');
  expect(attr(other, 'decoding')).toBe('async');
  // A decorative placeholder is hidden from assistive technology; a named one is an image with the title.
  const hidden = tag(render({ subject: book, cover: null, decorative: true }), 'div');
  expect(attr(hidden, 'aria-hidden')).toBe('true');
  const named = render({ subject: book, cover: null });
  expect(attr(tag(named, 'div'), 'role')).toBe('img');
  expect(attr(tag(named, 'div'), 'aria-label')).toBe('The Wind-Up Bird Chronicle');
});

test('at lg and larger the cover’s credit is reachable from the cover', async () => {
  for (const size of ['xs', 'sm', 'md'] as const) {
    expect(render({ subject: book, cover: summary(), size })).not.toContain('Cover credit');
    expect(render({ subject: book, cover: summary(), size, caption: true })).not.toContain('Shinchosha');
  }
  for (const size of ['lg', 'xl', 'fill'] as const) {
    expect(render({ subject: book, cover: summary(), size })).toContain('Cover credit');
    const captioned = render({ subject: book, cover: summary(), size, caption: true });
    const caption = captioned.slice(captioned.indexOf('<figcaption'), captioned.indexOf('</figcaption>'));
    expect(caption).toContain('Shinchosha');
    expect(caption).toContain('Open Library');
    expect(caption).toContain('href="https://openlibrary.org/"');
    expect(caption).toContain('All rights reserved');
  }
  // A cover without a credit shows no credit control.
  expect(render({ subject: book, cover: summary({ credit: null }), size: 'lg' })).not.toContain('Cover credit');
  // The credit opens from its control in the browser.
  await expectStories(['Credit At Large Sizes']);
}, 300_000);

test('a mixed row uses the ratio of most of its items, 5:7 when tied', () => {
  const of = (...types: string[]): CoverSubject[] =>
    types.map((type, index) => ({ id: `${type}${index}`, title: type, types: [type] }));
  expect(sharedRatio(of('schema:Book', 'schema:Book', 'schema:Person'))).toBe('5:7');
  expect(sharedRatio(of('schema:MusicAlbum', 'schema:MusicAlbum', 'schema:Book'))).toBe('1:1');
  expect(sharedRatio(of('schema:Person', 'schema:Person', 'schema:Person', 'schema:Book'))).toBe('3:4');
  expect(sharedRatio(of('schema:Recipe', 'schema:Recipe', 'schema:Book', 'schema:Book', 'schema:Person'))).toBe('5:7');
  // A tie goes to 5:7 even when 5:7 is not one of the tied ratios, and an empty row uses it too.
  expect(sharedRatio(of('schema:Person', 'schema:MusicAlbum'))).toBe('5:7');
  expect(sharedRatio(of('schema:Recipe', 'schema:Recipe', 'schema:Organization', 'schema:Organization'))).toBe('5:7');
  expect(sharedRatio([])).toBe('5:7');
  expect(sharedRatio(of('schema:Person'))).toBe('3:4');
  // Rows share the ratio through the prop; items keep their own images fitted to it.
  expect(attr(tag(render({ subject: person, cover: null, ratio: '2:3' }), 'div'), 'data-ratio')).toBe('2:3');
});
