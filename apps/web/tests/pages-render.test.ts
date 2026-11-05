import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { CompositionRender } from '../src/features/pages/render.tsx';

const definitions = [
  { type: 'Stack', slots: ['children'] },
  { type: 'Columns', slots: ['start', 'end'] },
  { type: 'Heading' },
];
const components = {
  Stack: ({ id, children }: { id: string; children: ReactNode }) => createElement('section', { id }, children),
  Columns: ({ start, end }: { start: ReactNode; end: ReactNode }) =>
    createElement('div', { className: 'columns' }, createElement('div', null, start), createElement('div', null, end)),
  Heading: (props: Record<string, unknown>) =>
    createElement('h2', { 'data-keys': Object.keys(props).sort().join(',') }, String(props.text)),
};
const heading = (id: string, text: string) => ({ type: 'Heading', props: { id, text, level: 2 } });
const document = {
  root: { props: { appearance: { density: 'compact' } } },
  content: [
    heading('title', 'Kokoro'),
    { type: 'Stack', props: { id: 'about', gap: 'sm', children: [heading('inside', 'Inside')] } },
    {
      type: 'Columns',
      props: { id: 'body', split: 'even', start: [heading('left', 'Left')], end: [heading('right', 'Right')] },
    },
  ],
};
const root = ({ appearance, children }: { appearance?: { density?: string }; children: ReactNode }) =>
  createElement('main', { 'data-density': appearance?.density ?? 'comfortable' }, children);
const render = (page: unknown) =>
  renderToString(createElement(CompositionRender, { document: page, definitions, components, root } as never));

test('a composition renders through Puck with named slot content in document order', () => {
  const html = render(document);
  expect(html).toContain('<main data-density="compact">');
  expect(html).toContain('<section id="about">');
  const order = ['Kokoro', 'Inside', 'Left', 'Right'].map((text) => html.indexOf(`>${text}</h2>`));
  expect(order.every((index) => index >= 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  expect(html).toContain('data-keys="id,level,text"');
  const left = html.indexOf('>Left</h2>');
  const right = html.indexOf('>Right</h2>');
  expect(html.slice(html.indexOf('class="columns"'), left)).not.toContain('Right');
  expect(left).toBeLessThan(right);
});

test('a node whose type has no component renders nothing and the rest of the page still renders', () => {
  const html = render({
    root: { props: {} },
    content: [
      heading('first', 'First'),
      { type: 'Carousel', props: { id: 'new', slides: [heading('hidden', 'Hidden')] } },
      { type: 'Stack', props: { id: 'kept', gap: 'sm', children: [heading('nested', 'Nested')] } },
    ],
  });
  expect(html).toContain('>First</h2>');
  expect(html).toContain('>Nested</h2>');
  expect(html).not.toContain('Hidden');
  expect(html).not.toContain('Carousel');
});

test('a malformed declared slot renders empty and keeps supported siblings in document order', () => {
  const html = render({
    root: { props: {} },
    content: [
      heading('first', 'First'),
      { type: 'Stack', props: { id: 'broken', gap: 'sm', children: 'not-nodes' } },
      {
        type: 'Columns',
        props: {
          id: 'body',
          split: 'even',
          start: heading('hidden', 'Hidden'),
          end: [heading('right', 'Right')],
        },
      },
      heading('last', 'Last'),
    ],
  });
  const order = ['First', 'Right', 'Last'].map((text) => html.indexOf(`>${text}</h2>`));
  expect(order.every((index) => index >= 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  expect(html).not.toContain('Hidden');
  expect(html).not.toContain('not-nodes');
});

test("the render path's initial load stays within 24 KiB", async () => {
  const entry = new URL('../src/features/pages/render.tsx', import.meta.url).pathname;
  const outdir = mkdtempSync(join(tmpdir(), 'pages-render-'));
  try {
    const build = await Bun.build({
      entrypoints: [entry],
      outdir,
      target: 'browser',
      minify: true,
      splitting: true,
      external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/server'],
    });
    expect(build.success).toBe(true);
    const name = (path: string) => path.split(/[\\/]/).at(-1)!;
    const outputs = new Map<string, string>();
    for (const output of build.outputs)
      if (output.kind !== 'sourcemap') outputs.set(name(output.path), await output.text());
    // Lazy chunks load only when a component uses them; count what a page loads at once.
    const initial = new Set<string>();
    const visit = (file: string) => {
      if (initial.has(file)) return;
      initial.add(file);
      for (const match of outputs.get(file)!.matchAll(/(?:from|import)\s*["']\.\/([^"']+)["']/g)) visit(match[1]!);
    };
    visit(name(build.outputs.find((output) => output.kind === 'entry-point')!.path));
    const bytes = [...initial].reduce(
      (total, file) => total + Bun.gzipSync(new TextEncoder().encode(outputs.get(file)!)).byteLength,
      0,
    );
    expect(bytes).toBeLessThanOrEqual(24 * 1024);
  } finally {
    rmSync(outdir, { recursive: true, force: true });
  }
});
