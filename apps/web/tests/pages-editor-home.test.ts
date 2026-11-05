import { expect, test } from 'bun:test';
import { platformRegistry, UI_LOCALES, validateComposition } from '@rezics/composition';
import { editorConfig, fromComposition, toComposition } from '../src/features/pages/editor-config.ts';

const config = editorConfig(platformRegistry, { locale: 'en' });
const fields = (type: string) => (config.components as Record<string, { fields: Record<string, any> }>)[type]!.fields;

test('the editor edits link lists and type lists', () => {
  const links = fields('LinkGrid').links;
  expect(links).toMatchObject({ type: 'array', min: 1, max: 12 });
  expect(links.arrayFields.href).toMatchObject({ type: 'text' });
  expect(Object.keys(links.arrayFields.label.objectFields)).toEqual([...UI_LOCALES]);
  expect(fields('TypeList').types).toMatchObject({ type: 'array' });
  expect(fields('TypeList').sort.options.map(({ value }: { value: string }) => value)).toEqual(['name', 'collections']);
  const document = {
    root: { props: {} },
    content: [
      {
        type: 'LinkGrid',
        props: { id: 'g', links: [{ label: { en: 'Books', fr: '' }, href: '/search?type=schema%3ABook' }] },
      },
      { type: 'TypeList', props: { id: 't', title: { en: 'Books' }, types: ['schema:Book'], sort: 'name', limit: 6 } },
    ],
  };
  const back = toComposition(fromComposition(document));
  expect(back.content[0]!.props.links).toEqual(document.content[0]!.props.links);
  expect(back.content[1]).toEqual(document.content[1]);
  expect(validateComposition(platformRegistry, back)).toEqual([]);
});
