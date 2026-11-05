import { expect, test } from 'bun:test';
import type { CompositionDocument, CompositionRegistry } from '@rezics/composition';
import { editorConfig, fromComposition, toComposition } from '../src/features/pages/editor-config';

const integer = (bounds: Record<string, number>) => ({ '~kind': 'Integer', ...bounds });
function registry(properties: Record<string, Record<string, unknown>>, required: string[] = Object.keys(properties)) {
  return {
    root: { properties: {} },
    components: [{ type: 'Counter', slots: [], props: { '~kind': 'Object', properties, required } }],
  } as unknown as CompositionRegistry;
}

test('integer controls and defaults honor effective integer bounds', () => {
  const config = editorConfig(
    registry({
      count: integer({ exclusiveMinimum: 2.2, exclusiveMaximum: 7.8 }),
      negative: integer({ maximum: -1.2 }),
    }),
    { locale: 'en' },
  );
  const counter = config.components.Counter as {
    fields: Record<string, unknown>;
    defaultProps: Record<string, unknown>;
  };
  expect(counter.fields.count).toMatchObject({ type: 'number', min: 3, max: 7, step: 1 });
  expect(counter.defaultProps).toMatchObject({ count: 3, negative: -2 });
});

test('impossible ranges fail and valid authored integers round-trip unchanged', () => {
  expect(() =>
    editorConfig(registry({ count: integer({ exclusiveMinimum: 4.1, maximum: 4.9 }) }, []), { locale: 'en' }),
  ).toThrow('Integer schema has no valid default');
  const source = {
    root: { props: {} },
    content: [{ type: 'Counter', props: { id: 'counter', count: 5 } }],
  } as CompositionDocument;
  const target = registry({ count: integer({ exclusiveMinimum: 2.2, exclusiveMaximum: 7.8 }) });
  expect(toComposition(fromComposition(source, target), target)).toEqual(source);
});
