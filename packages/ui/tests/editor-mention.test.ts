import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { normalizeDocument } from '@rezics/document';
import { DocumentBody } from '../src/components/document-body.tsx';

const root = join(import.meta.dir, '..');
const accountId = '0192f3a0-6c1e-7b2a-9d4e-000000000001';
const document = normalizeDocument({
  version: 'rezics-document-v1',
  profile: 'blocks',
  doc: {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        attrs: { id: 'p' },
        content: [
          { type: 'mention', attrs: { accountId } },
          { type: 'mention', attrs: { accountId: '0192f3a0-6c1e-7b2a-9d4e-000000000002' } },
        ],
      },
    ],
  },
});

test('mentions show the current handle as a locale link, or a plain @ for unknown accounts', () => {
  const html = renderToStaticMarkup(
    createElement(DocumentBody, {
      document,
      locale: 'zh-Hans',
      mentions: { [accountId]: { handle: 'current-handle' } },
    }),
  );
  expect(html).toContain('href="/zh-Hans/@current-handle"');
  expect(html).toContain('@current-handle</a>@');
  expect((html.match(/<a /g) ?? []).length).toBe(1);
  expect(renderToStaticMarkup(createElement(DocumentBody, { document }))).not.toContain('<a ');
});

test('mention handles containing markup and scripts render only as text and encoded attributes', () => {
  const handle = '<img src=x onerror=alert(1)><script>alert(2)</script>';
  const html = renderToStaticMarkup(
    createElement(DocumentBody, {
      document,
      locale: 'en',
      mentions: { [accountId]: { handle } },
    }),
  );
  expect(html).toContain('@&lt;img');
  expect(html).toContain(encodeURIComponent(handle));
  expect(html).not.toContain('<script');
  expect(html).not.toContain('<img');
});

test('a document link mark cannot replace a mention destination or link an unresolved mention', () => {
  const marked = normalizeDocument({
    ...document,
    doc: {
      ...document.doc,
      content: document.doc.content?.map((paragraph) => ({
        ...paragraph,
        content: paragraph.content?.map((node) => ({
          ...node,
          marks: [{ type: 'link', attrs: { href: 'https://other.test/' } }],
        })),
      })),
    },
  });
  const html = renderToStaticMarkup(
    createElement(DocumentBody, { document: marked, mentions: { [accountId]: { handle: 'current-handle' } } }),
  );
  expect(html).not.toContain('https://other.test/');
  expect(html.match(/<a /g)).toHaveLength(1);
  expect(html).toContain('@current-handle</a>@');
});

test('the mention menu debounces, aborts stale lookups, inserts account ids, preserves literal text and passes accessibility', async () => {
  const output = mkdtempSync(join(root, '../../.temp/editor-mention-'));
  const report = join(output, 'stories.json');
  try {
    const run = Bun.spawn(
      [
        'bun',
        'x',
        'vitest',
        'run',
        '--reporter=json',
        `--outputFile=${report}`,
        'src/components/editor-mention.stories.tsx',
      ],
      {
        cwd: root,
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, CI: '1' },
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
      run.exited,
    ]);
    expect(code, `${stdout.slice(-4000)}\n${stderr.slice(-4000)}`).toBe(0);
    const result = JSON.parse(readFileSync(report, 'utf8'));
    const outcomes = result.testResults
      .flatMap((file: any) => file.assertionResults)
      .map((assertion: any) => `${assertion.title}: ${assertion.status}`)
      .sort();
    expect(outcomes).toEqual([
      'Debounce And Cancel: passed',
      'Escape Keeps Text: passed',
      'Keyboard Choose: passed',
      'No Source: passed',
      'Pointer Choose: passed',
      'Unknown Handle: passed',
    ]);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}, 300_000);
