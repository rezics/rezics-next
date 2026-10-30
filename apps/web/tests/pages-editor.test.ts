import { expect, test } from 'bun:test';
import { platformRegistry, UI_LOCALES, validateComposition } from '@rezics/composition';
import { editorConfig, fromComposition, publishErrors, toComposition } from '../src/features/pages/editor-config.ts';

const config = editorConfig(platformRegistry, { locale: 'en' });
const fields = (type: string) => (config.components as Record<string, { fields: Record<string, any> }>)[type]!.fields;
const document = {
  root: { props: { appearance: { density: 'compact' } } },
  content: [
    {
      type: 'Columns',
      props: {
        id: 'cols',
        split: 'even',
        start: [{ type: 'Heading', props: { id: 'left', text: { en: 'Left', ja: '左' }, level: 2 } }],
        end: [{ type: 'Statements', props: { id: 'facts', properties: ['schema:author', 'schema:genre'] } }],
      },
    },
    { type: 'SubjectList', props: { id: 'works', title: 'Works', property: 'schema:author', limit: 6 } },
  ],
};

test("the editor's fields come from the registry", () => {
  expect(Object.keys(config.components).sort()).toEqual(platformRegistry.components.map(({ type }) => type).sort());
  expect(fields('Heading').level).toMatchObject({
    type: 'select',
    options: [
      { label: '1', value: 1 },
      { label: '2', value: 2 },
      { label: '3', value: 3 },
      { label: '4', value: 4 },
    ],
  });
  expect(fields('Heading').text.type).toBe('object');
  expect(Object.keys(fields('Heading').text.objectFields)).toEqual([...UI_LOCALES]);
  expect(fields('Heading').text.objectFields.ja).toMatchObject({ type: 'textarea', label: '日本語' });
  expect(fields('SubjectList').limit).toMatchObject({ type: 'number', min: 1, max: 24 });
  expect(fields('SubjectList').property).toMatchObject({ type: 'text' });
  expect(fields('Statements').properties).toMatchObject({ type: 'array' });
  expect(fields('Columns').start).toMatchObject({ type: 'slot' });
  expect(fields('Columns').end).toMatchObject({ type: 'slot' });
  expect((config.root as { fields: Record<string, { type: string }> }).fields.density?.type).toBe('select');
  for (const component of platformRegistry.components) {
    const node = { type: component.type, props: { id: 'x', ...config.components[component.type]!.defaultProps } };
    expect(validateComposition(platformRegistry, toComposition({ root: { props: {} }, content: [node] }))).toEqual([]);
  }
});

test('an edited page becomes a composition document', () => {
  const data = fromComposition(document);
  const edited = {
    ...data,
    zones: {},
    root: { ...data.root, props: { ...data.root.props, title: 'ignored' } },
  };
  const back = toComposition(edited);
  expect(back.content).toEqual(document.content);
  expect(Object.keys(back).sort()).toEqual(['content', 'root']);
  expect(validateComposition(platformRegistry, back)).toEqual([]);
  const blanks = toComposition(
    fromComposition({
      root: { props: {} },
      content: [{ type: 'Heading', props: { id: 'h', text: { en: 'Hi', fr: '' }, level: 3 } }],
    }),
  );
  expect(blanks.content[0]!.props.text).toEqual({ en: 'Hi' });
});

test('publishing refuses a document the platform would refuse', () => {
  expect(publishErrors(platformRegistry, fromComposition(document))).toEqual([]);
  const hostile = fromComposition({
    root: { props: {} },
    content: [
      { type: 'Heading', props: { id: 'h', text: { en: '<script>alert(1)</script>' }, level: 2 } },
      { type: 'SubjectList', props: { id: 'l', title: 'x', property: 'javascript:alert', limit: 99 } },
    ],
  });
  const errors = publishErrors(platformRegistry, hostile);
  expect(errors.map(({ pointer }) => pointer)).toEqual(
    expect.arrayContaining(['/content/0/props/text/en', '/content/1/props/limit']),
  );
  expect(errors.length).toBeGreaterThanOrEqual(2);
});
