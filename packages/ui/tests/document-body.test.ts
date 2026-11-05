import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DocumentSnapshot } from '@rezics/document';
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

test('an image without an authorized renderer stays unavailable and document affordances use supplied locale labels', () => {
  const document = snapshot([
    { type: 'image', attrs: { src: 'private-image', variant: 'medium', alt: 'A mountain' } },
    { type: 'image', attrs: { src: 'another-private-image', alt: '' } },
    { type: 'media', attrs: { src: 'private-audio', kind: 'audio', caption: 'An authored caption' } },
    {
      type: 'taskList',
      content: [{ type: 'taskItem', attrs: { checked: true }, content: [{ type: 'paragraph' }] }],
    },
    { type: 'extensionBlock', attrs: { definition: 'unknown-block', fallback: null } },
    {
      type: 'paragraph',
      content: [
        { type: 'extensionInline', attrs: { definition: 'unknown-inline', fallback: null } },
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
  expect(html).toContain('Image indisponible — A mountain');
  expect(html).toContain('role="img" aria-label="Image indisponible"');
  expect(html).toContain('<figcaption>An authored caption</figcaption>');
  expect(html).toContain('aria-label="État de la tâche"');
  expect(html).toContain('checked=""');
  expect(html).toContain('disabled=""');
  expect(html).toContain('data-document-component="unknown-block">Composant intégré</div>');
  expect(html).toContain('data-document-component="unknown-inline">Composant intégré</span>');
  expect(html).toContain('aria-label="Afficher le spoiler"');
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
  const document = snapshot([{ type: 'image', attrs: { src: 'media-id', alt: 'A mountain' } }]);
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
  expect(html).toContain('data-authorized-image="media-id">Owner-rendered image</span>');
  expect(html).not.toContain('Image unavailable');
  expect(renderToStaticMarkup(createElement(DocumentBody, { document, renderImage: () => null }))).not.toContain(
    'Image unavailable',
  );
});
