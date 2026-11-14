import { getSchema } from '@tiptap/core';
import { expect, test } from 'bun:test';
import { documentExtensionsForProfile } from '../src/components/document-extensions.ts';

test('the blocks editor exposes draggable top-level units and keeps parsing contract whitespace', () => {
  const schema = getSchema(documentExtensionsForProfile('blocks'));

  for (const name of ['paragraph', 'heading', 'blockquote', 'bulletList', 'codeBlock', 'image', 'media']) {
    expect(schema.nodes[name]?.spec.draggable, name).toBe(true);
  }
  for (const name of ['listItem', 'tableCell', 'tableRow']) {
    expect(schema.nodes[name]?.spec.draggable, name).not.toBe(true);
  }

  const paragraph = schema.nodes.paragraph!.createAndFill()!;
  const paragraphDOM = paragraph.type.spec.toDOM?.(paragraph);
  expect(Array.isArray(paragraphDOM)).toBe(true);
  const attributes = Array.isArray(paragraphDOM) ? paragraphDOM[1] : undefined;
  expect(attributes).toMatchObject({ draggable: 'true' });

  const paragraphParseRule = schema.nodes.paragraph!.spec.parseDOM?.find((rule) => 'tag' in rule && rule.tag === 'p');
  expect(paragraphParseRule?.preserveWhitespace).toBe('full');
  expect(schema.nodes.codeBlock?.spec.marks).toBe('');
});

test('text and blocks editor schemas preserve footnote references and editable top-level definitions', () => {
  for (const profile of ['text', 'blocks'] as const) {
    const schema = getSchema(documentExtensionsForProfile(profile));
    const reference = schema.nodes.footnoteReference!.create({ label: 'Source-1' });
    const paragraph = schema.nodes.paragraph!.create({ id: 'body' }, reference);
    const definition = schema.nodes.footnoteDefinition!.create(
      { id: 'definition', label: 'Source-1' },
      schema.nodes.paragraph!.create({ id: 'note' }, schema.text('Supplied source')),
    );
    const document = schema.nodes.doc!.create(null, [paragraph, definition]);
    const restored = schema.nodeFromJSON(document.toJSON());

    restored.check();
    expect(restored.toJSON()).toEqual(document.toJSON());
    expect(schema.nodes.footnoteReference!.spec.inline).toBe(true);
    expect(schema.nodes.footnoteDefinition!.spec.group).toBe('footnoteDefinition');
  }
});
