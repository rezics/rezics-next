import { expect, test, spyOn } from 'bun:test';
import { getSchema } from '@tiptap/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { documentVersion, normalizeDocument } from '@rezics/document';
import { documentExtensionsForProfile } from '../src/components/document-extensions.ts';
import {
  componentDOMAttributes,
  parseComponentAttributes,
  imageDOMAttributes,
  parseImageAttributes,
  mediaDOMAttributes,
  parseMediaAttributes,
} from '../src/components/document-component-data.ts';
import { applyImageProperties, applyMediaCaption, imageDimension } from '../src/components/editor-media-commands.ts';
import {
  editorMediaRuntime,
  registerEditorImagePreview,
  pruneEditorImagePreviewsFromDocument,
  refreshEditorMediaViews,
  clearEditorImagePreviews,
} from '../src/components/editor-media-runtime.ts';
import { DocumentBody } from '../src/components/document-body.tsx';
import { richTextEditorLabels } from '../src/components/editor-labels.ts';
import { editorSnapshot } from '../src/components/rich-text-editor-snapshot.ts';
import { editorStateFixture } from './helpers/editor-state.ts';

function element(attributes: Record<string, string>): HTMLElement {
  return {
    getAttribute: (name: string) => attributes[name] ?? null,
    hasAttribute: (name: string) => Object.hasOwn(attributes, name),
  } as unknown as HTMLElement;
}

test('opaque inline and block clipboard metadata keeps version, arbitrary payload and exact fallback', () => {
  const attrs = {
    id: 'unit',
    definition: 'example.component',
    version: '2-beta',
    payload: { nested: [{ value: '  漢字\n' }, null, true, 0], future: { key: '<script>literal</script>' } },
    fallback: '  Fallback\n漢字  ',
  };
  const encoded = componentDOMAttributes(attrs);
  expect(parseComponentAttributes(element(encoded))).toEqual(attrs);
  expect(parseComponentAttributes(element({ 'data-document-component': 'example.component' }))).toBe(false);
  expect(parseComponentAttributes(element({ ...encoded, 'data-document-component-payload': '1e400' }))).toBe(false);
  const schema = getSchema(documentExtensionsForProfile('blocks'));
  for (const type of ['extensionInline', 'extensionBlock']) {
    const node = schema.nodes[type]!.create(attrs);
    const dom = node.type.spec.toDOM!(node) as [string, Record<string, string>, string];
    expect(dom[2]).toBe(attrs.fallback);
    const rule = node.type.spec.parseDOM!.find((entry) => entry.tag?.includes('data-document-component'))!;
    expect(rule.getAttrs!(element(dom[1]))).toMatchObject(attrs);
    expect(rule.getAttrs!(element({ ...dom[1], payload: 'conflicting legacy attribute', version: '1' }))).toMatchObject(
      attrs,
    );
  }
});

test('opaque string metadata is JSON-escaped so HTML parsing cannot normalize authored control characters', () => {
  const attrs = {
    id: 'unit',
    definition: 'example\u0000component',
    version: '2\u0000beta',
    payload: { value: '\u0000' },
    fallback: 'Fallback\u0000\ud800',
  };
  const encoded = componentDOMAttributes(attrs);
  for (const field of ['definition', 'version', 'fallback'])
    expect(encoded[`data-document-component-${field}`]).not.toContain('\u0000');
  expect(parseComponentAttributes(element(encoded))).toEqual(attrs);
});

test('image/media clipboard uses inert attributes and roundtrips every occurrence value', () => {
  const schema = getSchema(documentExtensionsForProfile('blocks'));
  const image = {
    id: 'image',
    src: 'opaque-native-id',
    alt: 'Description',
    title: 'Title',
    width: 200.5,
    height: 100,
    conceal: true,
    lang: 'ja',
    dir: 'auto',
  };
  const encoded = imageDOMAttributes(image);
  expect(parseImageAttributes(element(encoded))).toEqual(image);
  const node = schema.nodes.image!.create(image);
  const dom = node.type.spec.toDOM!(node) as [string, Record<string, string>];
  expect(dom[0]).toBe('figure');
  expect(dom[1]).not.toHaveProperty('src');
  const own = node.type.spec.parseDOM!.find((entry) => entry.tag === 'figure[data-document-image]')!;
  expect(own.getAttrs!(element(dom[1]))).toMatchObject(image);
  expect(
    own.getAttrs!(element({ ...dom[1], src: 'forged-source', width: '900', 'data-conceal': 'false' })),
  ).toMatchObject(image);
  const media = { id: 'file', src: 'opaque-attachment', kind: 'audio', caption: 'A caption', lang: null, dir: null };
  expect(parseMediaAttributes(element(mediaDOMAttributes(media)))).toEqual(media);
  expect(parseImageAttributes(element(imageDOMAttributes({ ...image, width: -1 })))).toBe(false);
});

test('image properties are one guarded history edit and never change occurrence identity or source', () => {
  const fixture = editorStateFixture({
    type: 'doc',
    content: [{ type: 'image', attrs: { id: 'image', src: 'stored-media', alt: 'Before' } }],
  });
  const { editor } = fixture;
  const target = { editor, node: editor.state.doc.firstChild!, getPos: () => 0 };
  const properties = { alt: 'After', title: 'Image title', width: 240, height: 120, conceal: true };
  expect(applyImageProperties(target, properties, () => false)).toBe(false);
  expect(applyImageProperties(target, properties, () => true)).toBe(true);
  expect(editor.state.doc.firstChild!.attrs).toMatchObject({ id: 'image', src: 'stored-media', ...properties });
  expect(applyImageProperties(target, { ...properties, alt: 'Stale' }, () => true)).toBe(false);
  expect(editorSnapshot(editor.state.doc, 'blocks').doc.content![0]!.attrs!.alt).toBe('After');
  expect(imageDimension('')).toBeNull();
  expect(imageDimension('12.5')).toBe(12.5);
  expect(imageDimension('0')).toBe(false);
  fixture.setEditable(false);
  expect(applyImageProperties({ ...target, node: editor.state.doc.firstChild! }, properties, () => true)).toBe(false);
});

test('equal-byte media visit replacement retires property targets even when the editor and node stay identical', () => {
  const fixture = editorStateFixture({
    type: 'doc',
    content: [{ type: 'image', attrs: { id: 'image', src: 'native-media', alt: 'Original' } }],
  });
  const { editor } = fixture;
  let generation = 0;
  const target = {
    editor,
    node: editor.state.doc.firstChild!,
    getPos: () => 0,
    generation,
    currentGeneration: () => generation,
  };
  generation++;
  expect(
    applyImageProperties(target, { alt: 'Stale', title: null, width: null, height: null, conceal: false }, () => true),
  ).toBe(false);
  expect(editor.state.doc.firstChild!.attrs.alt).toBe('Original');
});

test('media captions change without changing the admitted kind/source; unavailable leaves stay readable', () => {
  const fixture = editorStateFixture({
    type: 'doc',
    content: [{ type: 'media', attrs: { id: 'media', src: 'source', kind: 'video', caption: 'Before' } }],
  });
  const { editor } = fixture;
  expect(applyMediaCaption({ editor, node: editor.state.doc.firstChild!, getPos: () => 0 }, 'After', () => true)).toBe(
    true,
  );
  expect(editor.state.doc.firstChild!.attrs).toMatchObject({
    id: 'media',
    src: 'source',
    kind: 'video',
    caption: 'After',
  });
  const html = renderToStaticMarkup(
    createElement(DocumentBody, { document: editorSnapshot(editor.state.doc, 'blocks') }),
  );
  expect(html).toContain('Media unavailable');
  expect(html).toContain('After');
  expect(html).not.toContain('<video');
});

test('reader image ports receive full independent occurrences and concealed images do not invoke the renderer', () => {
  const snapshot = normalizeDocument({
    version: documentVersion,
    profile: 'blocks',
    doc: {
      type: 'doc',
      content: [
        {
          type: 'image',
          attrs: {
            id: 'visible',
            src: 'same-media',
            alt: 'Visible',
            title: 'Title',
            width: 160,
            height: 80,
            conceal: false,
          },
        },
        {
          type: 'image',
          attrs: { id: 'concealed', src: 'same-media', alt: 'Concealed', width: 320, height: 160, conceal: true },
        },
      ],
    },
  });
  const seen: unknown[] = [];
  const html = renderToStaticMarkup(
    createElement(DocumentBody, {
      document: snapshot,
      renderImage: (occurrence) => {
        seen.push(occurrence);
        return createElement('span', {}, 'Admitted preview');
      },
    }),
  );
  expect(seen).toEqual([
    {
      id: 'visible',
      src: 'same-media',
      mediaId: 'same-media',
      alt: 'Visible',
      title: 'Title',
      width: 160,
      height: 80,
      conceal: false,
    },
  ]);
  expect(html).toContain('Admitted preview');
  expect(html).toContain('Reveal image');
  expect(html).toContain('Concealed');
});

test('local accepted previews never enter JSON and revoke on removal, source replacement and visit retirement', () => {
  const fixture = editorStateFixture({
    type: 'doc',
    content: [{ type: 'image', attrs: { id: 'image', src: 'native-media' } }],
  });
  const { editor } = fixture;
  const revoked: string[] = [];
  const original = URL.revokeObjectURL;
  const revoke = spyOn(URL, 'revokeObjectURL').mockImplementation((url) => {
    revoked.push(url);
    original(url);
  });
  try {
    const file = new File(['local bytes'], 'image.png', { type: 'image/png' });
    const runtime = editorMediaRuntime(editor);
    let visit = 'A';
    runtime.ports = () => ({ labels: richTextEditorLabels, isCurrent: () => true, visit });
    refreshEditorMediaViews(editor);
    registerEditorImagePreview(editor, 'image', 'native-media', file);
    expect(runtime.previews.size).toBe(1);
    expect(JSON.stringify(editorSnapshot(editor.state.doc, 'blocks'))).not.toContain('blob:');
    pruneEditorImagePreviewsFromDocument(
      editor,
      editor.schema.nodes.doc!.create(null, editor.schema.nodes.paragraph!.create()),
    );
    expect(runtime.previews.size).toBe(0);
    expect(revoked).toHaveLength(1);
    registerEditorImagePreview(editor, 'image', 'native-media', file);
    visit = 'B';
    refreshEditorMediaViews(editor);
    expect(runtime.previews.size).toBe(0);
    expect(revoked).toHaveLength(2);
  } finally {
    clearEditorImagePreviews(editor);
    revoke.mockRestore();
  }
});
