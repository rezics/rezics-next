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
