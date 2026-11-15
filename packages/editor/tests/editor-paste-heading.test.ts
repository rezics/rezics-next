import { expect, test } from 'bun:test';
import { getSchema, type Extensions, type Node as TiptapNode } from '@tiptap/core';
import { Fragment, Slice } from '@tiptap/pm/model';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { documentExtensionsForProfile } from '../src/components/document-extensions.ts';

function pasteFirstHeading(extensions: Extensions) {
  const schema = getSchema(extensions);
  const sourceHeading = schema.nodes.heading!.create(
    { id: 'incoming-heading', level: 2, lang: 'ja', dir: 'rtl', textAlign: 'right' },
    schema.text('First structured heading'),
  );
  const sourceParagraph = schema.nodes.paragraph!.create(
    { id: 'incoming-body' },
    schema.text('Formatted opening', [schema.marks.bold!.create()]),
  );
  // This is the maintained parser's shape for external HTML, without private clipboard slice metadata.
  const slice = Slice.maxOpen(Fragment.fromArray([sourceHeading, sourceParagraph]));
  const before = schema.nodes.doc!.create(null, schema.nodes.paragraph!.create({ id: 'target' }));
  const state = EditorState.create({ schema, doc: before, selection: TextSelection.create(before, 1) });
  return { before, sourceParagraph, slice, pasted: state.apply(state.tr.replaceSelection(slice)).doc };
}

test.each(['text', 'blocks'] as const)(
  '%s native external paste preserves the first authored heading and following marks',
  (profile) => {
    const { before, sourceParagraph, slice, pasted } = pasteFirstHeading(documentExtensionsForProfile(profile));
    expect(slice.openStart).toBe(1);
    expect(before.firstChild!.type.name).toBe('paragraph');
    expect(pasted.firstChild!.type.name).toBe('heading');
    expect(pasted.firstChild!.attrs).toMatchObject({
      id: 'incoming-heading',
      level: 2,
      lang: 'ja',
      dir: 'rtl',
      textAlign: 'right',
    });
    expect(pasted.firstChild!.textContent).toBe('First structured heading');
    expect(pasted.lastChild!.toJSON()).toEqual(sourceParagraph.toJSON());
    expect(before.textContent).toBe('');
  },
);

test.each(['text', 'blocks'] as const)(
  '%s non-defining heading control reproduces a paragraph-context paste',
  (profile) => {
    const extensions = documentExtensionsForProfile(profile).map((extension) =>
      extension.name === 'heading' ? (extension as TiptapNode).extend({ defining: false }) : extension,
    );
    const { pasted } = pasteFirstHeading(extensions);
    expect(pasted.firstChild!.type.name).toBe('paragraph');
    expect(pasted.firstChild!.textContent).toBe('First structured heading');
  },
);
