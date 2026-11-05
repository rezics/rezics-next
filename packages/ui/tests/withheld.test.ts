import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const root = join(import.meta.dir, '..');
const output = join(root, '../../.temp/withheld-acceptance');

test('Tombstone accepts an unavailable reason, the default, which says only that the item is not available and claims no reason, for a reference whose record the reader cannot see or that no longer exists', async () => {
  const { Tombstone } = await import('../src/components/tombstone.tsx');
  for (const shape of ['post', 'card', 'row'] as const) {
    const implicit = renderToStaticMarkup(createElement(Tombstone, { shape }));
    const explicit = renderToStaticMarkup(createElement(Tombstone, { shape, reason: 'unavailable' }));
    expect(implicit).toBe(explicit);
    expect(implicit).toContain('Not available');
    expect(implicit).not.toMatch(/deleted|withheld|private|permission|<button|<a\b|<img\b/i);
  }
  const owner = renderToStaticMarkup(
    createElement(Tombstone, {
      shape: 'row',
      restoreUntil: new Date(Date.now() + 86_400_000),
      onRestore() {},
      labels: { unavailable: 'Indisponible' },
    }),
  );
  expect(owner).toContain('Indisponible');
  expect(owner).not.toMatch(/<button|<time/);
});

test('Withheld renders in place of one withheld image, passage or field and leaves the rest of the record visible: an image keeps its frame and aspect ratio, a passage keeps its block, a field keeps its label', async () => {
  const { Withheld } = await import('../src/components/withheld.tsx');
  const html = renderToStaticMarkup(
    createElement(
      'article',
      null,
      createElement('h2', null, 'Visible title'),
      createElement(Withheld, { shape: 'image', ratio: 3 / 4 }),
      createElement('p', null, 'Visible passage before'),
      createElement(Withheld, { shape: 'passage', style: { minHeight: 160 } }),
      createElement('p', null, 'Visible passage after'),
      createElement(Withheld, { shape: 'field', label: 'Translator' }),
      createElement('p', null, 'Other field: 2026'),
    ),
  );
  for (const text of [
    'Visible title',
    'Visible passage before',
    'Visible passage after',
    'Translator',
    'Other field: 2026',
  ]) {
    expect(html).toContain(text);
  }
  expect(html).toContain('data-shape="image"');
  expect(html).toContain('--ratio:0.75');
  expect(html).toMatch(/<div[^>]*data-shape="passage"[^>]*style="min-height:160px"/);
  expect(html).toMatch(/<dt[^>]*>Translator<\/dt>/);
  expect(html).toMatch(/<dd[^>]*>Withheld in response to a notice\.<\/dd>/);
});

test('Withheld never shows the withheld content, its alt text or its file name, and says that it is withheld in response to a notice', async () => {
  const { Withheld } = await import('../src/components/withheld.tsx');
  const forbidden = {
    children: 'Secret passage',
    alt: 'Secret alt text',
    fileName: 'secret-file.jpg',
    src: '/secret-file.jpg',
    title: 'Secret title',
    onClick() {},
  };
  for (const props of [
    { shape: 'image', ratio: 16 / 9 },
    { shape: 'passage' },
    { shape: 'field', label: 'Illustrator' },
  ] as const) {
    const html = renderToStaticMarkup(createElement(Withheld, { ...props, ...forbidden }));
    expect(html).toContain('Withheld in response to a notice.');
    expect(html).not.toMatch(/Secret|secret-file|<img|<picture|<a\b|<button|<input|src=|alt=|title=/);
  }
  const translated = renderToStaticMarkup(
    createElement(Withheld, {
      shape: 'passage',
      labels: { withheld: 'Retenu à la suite d’un avis.' },
    }),
  );
  expect(translated).toContain('Retenu à la suite d’un avis.');
  expect(translated).not.toContain('Withheld in response');
});

test('the Withheld stories have no accessibility violations in light and dark themes', async () => {
  mkdirSync(output, { recursive: true });
  const report = join(output, 'stories.json');
  const run = Bun.spawn(
    [
      'bun',
      'scripts/isolated.ts',
      'bun',
      'x',
      'vitest',
      'run',
      '--reporter=json',
      `--outputFile=${report}`,
      'src/components/withheld.stories.tsx',
    ],
    { cwd: root, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, CI: '1' } },
  );
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
      run.exited,
    ]);
    expect(code, `${stdout}\n${stderr}`).toBe(0);
    const result = JSON.parse(readFileSync(report, 'utf8')) as {
      testResults: { assertionResults: { status: string; title: string }[] }[];
    };
    expect(
      result.testResults
        .flatMap((file) => file.assertionResults)
        .map((test) => `${test.title}: ${test.status}`)
        .sort(),
    ).toEqual(['Dark: passed', 'Light: passed']);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}, 300_000);
