import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DocumentNode, DocumentSnapshot } from '@rezics/document';
import { DocumentBody } from '../src/components/document-body.tsx';

const root = join(import.meta.dir, '..');
const stories = 'src/components/document-body.stories.tsx';

test('document bodies render every profile node and mark, safe links, spoilers and media images as accessible stories', async () => {
  expect(existsSync(join(root, stories)), stories).toBe(true);
  const output = mkdtempSync(join(tmpdir(), 'rezics-ui-document-body-'));
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
    const outcomes = result.testResults
      .flatMap((file) => file.assertionResults)
      .map((assertion) =>
        `${assertion.title}: ${assertion.status} ${assertion.failureMessages[0]?.split('\n')[0] ?? ''}`.trim(),
      )
      .sort();
    expect(outcomes).toEqual([
      'Blocks Profile: passed',
      'Disclosure Replacement: passed',
      'Inline Spoiler: passed',
      'Localized Label: passed',
      'Media Images: passed',
      'Safe Links: passed',
      'Spoilers: passed',
      'Text Profile: passed',
      'Two Spoilers: passed',
    ]);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}, 300_000);

const snapshot = (content: DocumentSnapshot['doc']['content']): DocumentSnapshot => ({
  version: 'rezics-document-v1',
  profile: 'blocks',
  doc: { type: 'doc', content },
});

test('DocumentBody preserves common attributes through default output and defaultContent callbacks', () => {
  const code = (language: string, attrs: DocumentNode['attrs'] = {}) =>
    ({
      type: 'codeBlock',
      attrs: { language, ...attrs },
      content: [{ type: 'text', text: 'same code' }],
    }) satisfies DocumentNode;
  const table = (caption: string, id: string, lang: string, dir: string) =>
    ({
      type: 'table',
      attrs: { caption, id, lang, dir },
      content: [
        {
          type: 'tableRow',
          content: [
            {
              type: 'tableHeader',
              attrs: { id: `${id}-header`, lang, dir },
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'same cell' }] }],
            },
          ],
        },
      ],
    }) satisfies DocumentNode;
  const document = snapshot([
    code('typescript', { id: 'code-one', lang: 'ar', dir: 'rtl' }),
    code('typescript', { id: 'code-two', lang: 'fr', dir: 'ltr' }),
    code('typescript'),
    table('First table', 'table-one', 'ar', 'rtl'),
    table('Second table', 'table-two', 'fr', 'ltr'),
  ]);
  const codeOccurrences: { occurrence: number; id: unknown; language: unknown }[] = [];
  const tableOccurrences: { occurrence: number; id: unknown; caption: unknown }[] = [];
  const plain = renderToStaticMarkup(createElement(DocumentBody, { document }));
  const withCallbacks = renderToStaticMarkup(
    createElement(DocumentBody, {
      document,
      renderCodeBlock: (node, _children, defaultContent, occurrence) => {
        codeOccurrences.push({ occurrence, id: node.attrs?.id, language: node.attrs?.language });
        return defaultContent;
      },
      renderTable: (node, _children, defaultContent, occurrence) => {
        tableOccurrences.push({ occurrence, id: node.attrs?.id, caption: node.attrs?.caption });
        return defaultContent;
      },
    }),
  );

  expect(codeOccurrences).toEqual([
    { occurrence: 0, id: 'code-one', language: 'typescript' },
    { occurrence: 1, id: 'code-two', language: 'typescript' },
    { occurrence: 2, id: undefined, language: 'typescript' },
  ]);
  expect(tableOccurrences).toEqual([
    { occurrence: 0, id: 'table-one', caption: 'First table' },
    { occurrence: 1, id: 'table-two', caption: 'Second table' },
  ]);
  expect(withCallbacks).toBe(plain);
  expect(plain).toContain('<pre data-block-id="code-one" lang="ar" dir="rtl">');
  expect(plain).toContain('<pre data-block-id="code-two" lang="fr" dir="ltr">');
  expect(plain).toContain('<pre><code data-language="typescript">same code</code></pre>');
  expect(plain.match(/data-block-id="code-one"/g) ?? []).toHaveLength(1);
  expect(plain.match(/data-block-id="code-two"/g) ?? []).toHaveLength(1);
  expect(plain).toContain('data-block-id="table-one" lang="ar" dir="rtl"');
  expect(plain).toContain('data-block-id="table-one-header" lang="ar" dir="rtl"');
  expect(plain).toContain('data-block-id="table-two" lang="fr" dir="ltr"');
  expect(plain).toContain('data-block-id="table-two-header" lang="fr" dir="ltr"');
});

test('custom block mappings preserve common attributes and accessible document affordances', () => {
  const document = snapshot([
    {
      type: 'image',
      attrs: { src: 'private-image', variant: 'medium', alt: 'A mountain', id: 'image-anchor', lang: 'ar', dir: 'rtl' },
    },
    { type: 'image', attrs: { src: 'another-private-image', alt: '' } },
    {
      type: 'media',
      attrs: {
        src: 'private-audio',
        kind: 'audio',
        caption: 'An authored caption',
        id: 'media-anchor',
        lang: 'ja',
        dir: 'ltr',
      },
    },
    {
      type: 'taskList',
      content: [
        {
          type: 'taskItem',
          attrs: { checked: true, id: 'task-anchor', lang: 'ar', dir: 'rtl' },
          content: [{ type: 'paragraph' }],
        },
      ],
    },
    {
      type: 'horizontalRule',
      attrs: { id: 'rule-anchor', lang: 'he', dir: 'rtl' },
    },
    {
      type: 'extensionBlock',
      attrs: { definition: 'unknown-block', fallback: null, id: 'extension-anchor', lang: 'zh-Hant', dir: 'ltr' },
    },
    {
      type: 'paragraph',
      content: [
        { type: 'extensionInline', attrs: { definition: 'unknown-inline', fallback: null, id: 'inline-anchor' } },
        { type: 'text', text: 'The ending', marks: [{ type: 'spoiler' }] },
      ],
    },
  ]);
  const html = renderToStaticMarkup(
    createElement(DocumentBody, {
      document,
      labels: {
        imageUnavailable: 'Image indisponible',
        taskStatus: 'État de la tâche',
        embeddedComponent: 'Composant intégré',
        revealSpoiler: 'Afficher le spoiler',
      },
    }),
  );
  expect(html).not.toContain('<img');
  expect(html).not.toContain('/media/');
  expect(html).not.toContain('private-image');
  expect(html).not.toContain('private-audio');
  expect(html).toContain('role="img" aria-label="A mountain"');
  expect(html).toContain('data-block-id="image-anchor" lang="ar" dir="rtl"');
  expect(html).toContain('Image indisponible — A mountain');
  expect(html).toContain('role="img" aria-label="Image indisponible"');
  expect(html).toContain('<figure data-block-id="media-anchor" lang="ja" dir="ltr">');
  expect(html).toContain('<figcaption>An authored caption</figcaption>');
  expect(html).toContain('<li data-block-id="task-anchor" lang="ar" dir="rtl">');
  expect(html).toContain('aria-label="État de la tâche"');
  expect(html).toContain('checked=""');
  expect(html).toContain('disabled=""');
  expect(html).toContain(
    'data-document-component="unknown-block" data-block-id="extension-anchor" lang="zh-Hant" dir="ltr">Composant intégré</div>',
  );
  expect(html).toContain(
    'data-document-component="unknown-inline" data-block-id="inline-anchor">Composant intégré</span>',
  );
  expect(html).toContain('<hr data-block-id="rule-anchor" lang="he" dir="rtl"');
  expect(html).toContain('aria-label="Afficher le spoiler"');
});

test('caller renderers keep authored common attributes on replacement output', () => {
  const document = snapshot([
    {
      type: 'codeBlock',
      attrs: { id: 'custom-code', lang: 'ar', dir: 'rtl', language: 'typescript' },
      content: [{ type: 'text', text: 'same code' }],
    },
    {
      type: 'table',
      attrs: { id: 'custom-table', lang: 'fr', dir: 'ltr', caption: 'Custom table' },
      content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [{ type: 'paragraph' }] }] }],
    },
    { type: 'image', attrs: { src: 'media-id', alt: 'A mountain', id: 'custom-image', lang: 'he', dir: 'rtl' } },
  ]);
  const html = renderToStaticMarkup(
    createElement(DocumentBody, {
      document,
      renderCodeBlock: (_node, children) => createElement('aside', null, children),
      renderTable: (node) => createElement('section', null, node.attrs?.caption as string),
      renderImage: ({ mediaId }) => createElement('span', { 'data-authorized-image': mediaId }, 'Owner image'),
    }),
  );

  expect(html).toContain('<div data-block-id="custom-code" lang="ar" dir="rtl"><aside>same code</aside></div>');
  expect(html).toContain('<div data-block-id="custom-table" lang="fr" dir="ltr"><section>Custom table</section></div>');
  expect(html).toContain(
    '<div data-block-id="custom-image" lang="he" dir="rtl"><span data-authorized-image="media-id">Owner image</span></div>',
  );
  expect(html).not.toContain('/media/');
});

test('partial document labels keep English defaults and authored extension fallbacks stay independent', () => {
  const document = snapshot([
    { type: 'image', attrs: { src: 'private-image' } },
    {
      type: 'taskList',
      content: [{ type: 'taskItem', content: [{ type: 'paragraph' }] }],
    },
    { type: 'extensionBlock', attrs: { definition: 'block', fallback: 'Authored block text' } },
    { type: 'extensionBlock', attrs: { definition: 'empty', fallback: '' } },
    {
      type: 'paragraph',
      content: [{ type: 'extensionInline', attrs: { definition: 'inline', fallback: 'Authored inline text' } }],
    },
  ]);
  const html = renderToStaticMarkup(createElement(DocumentBody, { document, labels: { revealSpoiler: 'Show' } }));
  expect(html).toContain('role="img" aria-label="Image unavailable"');
  expect(html).toContain('aria-label="Task status"');
  expect(html).toContain('data-document-component="block">Authored block text</div>');
  expect(html).toContain('data-document-component="inline">Authored inline text</span>');
  expect(html).toContain('data-document-component="empty"></div>');
});

test('a supplied image renderer is exclusive even when it returns nothing', () => {
  const document = snapshot([
    { type: 'image', attrs: { src: 'media-id', alt: 'A mountain', id: 'image-anchor', lang: 'ar', dir: 'rtl' } },
  ]);
  const calls: { mediaId: string; alt: string }[] = [];
  const html = renderToStaticMarkup(
    createElement(DocumentBody, {
      document,
      renderImage: (image) => {
        calls.push(image);
        return createElement('span', { 'data-authorized-image': image.mediaId }, 'Owner-rendered image');
      },
    }),
  );
  expect(calls).toEqual([{ mediaId: 'media-id', alt: 'A mountain' }]);
  expect(html).toContain(
    '<div data-block-id="image-anchor" lang="ar" dir="rtl"><span data-authorized-image="media-id">Owner-rendered image</span></div>',
  );
  expect(html).not.toContain('Image unavailable');
  expect(renderToStaticMarkup(createElement(DocumentBody, { document, renderImage: () => null }))).not.toContain(
    'Image unavailable',
  );
});
