import { expect, test } from 'bun:test';
import { Compile } from 'typebox/schema';
import { compositionSchema, platformRegistry, validateComposition } from '../src/index.ts';

const page = (href: string) => ({
  root: { props: {} },
  content: [{ type: 'LinkGrid', props: { id: 'links', links: [{ label: 'Browse', href }] } }],
});

test('configured links accept usable paths and HTTPS ports through 65,535 consistently', () => {
  const schema = Compile(compositionSchema(platformRegistry) as never);
  for (const href of ['/search', 'https://example.org:65535/search']) {
    const document = page(href);
    expect(validateComposition(platformRegistry, document)).toEqual([]);
    expect(schema.Check(document)).toBe(true);
  }
  const invalidPort = page('https://example.org:99999/search');
  expect(validateComposition(platformRegistry, invalidPort)).toEqual([
    { pointer: '/content/0/props/links/0/href', code: 'unsafe' },
  ]);
  expect(schema.Check(invalidPort)).toBe(false);
});
