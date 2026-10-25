// SPDX-License-Identifier: Apache-2.0
import { expect, test } from 'bun:test';
import canonicalize from 'canonicalize';
import { join } from 'node:path';
import * as exported from '../src/index.ts';
import {
  checkDocument,
  documentText,
  documentVersion,
  fromMarkdown,
  fromPlainText,
  normalizeDocument,
  parseDocument,
  serializeDocument,
  type DocumentNode,
  type DocumentSnapshot,
} from '../src/index.ts';

const root = join(import.meta.dir, '..');
const snapshot = (content: DocumentNode[], profile: 'text' | 'blocks' = 'blocks'): DocumentSnapshot => ({
  version: documentVersion,
  profile,
  doc: { type: 'doc', content },
});

test('stored text is the RFC 8785 canonical form of the normalized snapshot', () => {
  const value = snapshot([
    { type: 'paragraph', attrs: { lang: 'ja', id: 'p1' }, content: [{ type: 'text', text: 'é😀 ' }] },
    {
      type: 'extensionBlock',
      attrs: {
        payload: { '€': 1e21, '😀': 0.000001, דּ: 'x', z: [1.5, 'a'], A: { b: null, a: true } },
        fallback: 'fallback',
        version: '1',
        definition: 'https://example.org/block',
        id: 'x1',
      },
    },
  ]);
  const stored = serializeDocument(value);
  expect(stored).toBe(canonicalize(normalizeDocument(value))!);
  expect(parseDocument(JSON.parse(stored))).toEqual(normalizeDocument(value));
});

test('a Blocks image keeps its content attributes and no longer carries legacy media identities', () => {
  const image = {
    type: 'image',
    attrs: {
      id: 'i1',
      src: 'https://example.org/a.png',
      alt: 'A',
      title: null,
      width: 640,
      height: 480,
      conceal: true,
    },
  };
  expect(checkDocument(snapshot([image]))).toBe(true);
  expect(
    checkDocument(
      snapshot([{ ...image, attrs: { ...image.attrs, representationId: '11111111-1111-4111-8111-111111111111' } }]),
    ),
  ).toBe(false);
  expect(
    checkDocument(
      snapshot([{ ...image, attrs: { ...image.attrs, mediaUseId: '22222222-2222-4222-8222-222222222222' } }]),
    ),
  ).toBe(false);
});

test('blocks from the retired legacy vocabulary are ordinary opaque extensions', () => {
  expect(Object.keys(exported).filter((name) => name.includes('WorkReference'))).toEqual([]);
  const block = {
    type: 'extensionBlock',
    attrs: {
      id: 'w1',
      definition: 'https://rezics.com/definition/work-reference-block-v1',
      version: '1',
      fallback: 'A work',
      payload: { anything: ['kept', 1] },
    },
  };
  expect(normalizeDocument(snapshot([block])).doc.content![0]!.attrs!.payload).toEqual({ anything: ['kept', 1] });
});

test('plain text and CommonMark import produce valid snapshots', () => {
  const text = fromPlainText('漢字\nSecond paragraph');
  expect(text.profile).toBe('text');
  expect(documentText(text)).toBe('漢字\nSecond paragraph');
  const markdown = fromMarkdown('# Title\n\nSome *emphasis* and **strength**.');
  expect(checkDocument(markdown)).toBe(true);
  expect(documentText(markdown)).toContain('Some emphasis and strength.');
});

test('published schemas are generated from the source and omit retired attributes', async () => {
  const check = Bun.spawnSync(['bun', 'scripts/schema.ts', '--check'], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  expect(check.exitCode).toBe(0);
  for (const name of ['rezics-document-core-v1', 'rezics-text-v1', 'rezics-blocks-v1']) {
    const text = await Bun.file(join(root, 'schema', `${name}.schema.json`)).text();
    for (const retired of ['representationId', 'mediaUseId', 'rv:work']) expect(text).not.toContain(retired);
  }
});

test('the package is an Apache-2.0 workspace with exact dependency versions', async () => {
  const manifest = (await Bun.file(join(root, 'package.json')).json()) as {
    name: string;
    license: string;
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  expect(manifest.name).toBe('@rezics/document');
  expect(manifest.license).toBe('Apache-2.0');
  expect(typeof manifest.scripts?.check).toBe('string');
  for (const version of Object.values({ ...manifest.dependencies, ...manifest.devDependencies }))
    expect(version).toMatch(/^(?:\d+\.\d+\.\d+(?:-[\w.]+)?|workspace:\*)$/);
});
