import { expect, test } from 'bun:test';
import { Compile } from 'typebox/schema';
import { bundledRelease } from '../src/bundled.ts';
import { CatalogueError, compileCatalogue } from '../src/compile.ts';
import { validateRelease, valueSchema } from '../src/index.ts';

const UUID = '019a1b2c-3d4e-7f00-8a00-5b0000000061';

test('content value schemas describe the portable envelope and refuse quantity and pattern options', () => {
  expect(Compile(valueSchema('media')).Check(UUID)).toBe(true);
  for (const content of [42, {}, 'cover.jpg', `${UUID}\n`])
    expect(Compile(valueSchema('media')).Check(content)).toBe(false);
  const document = Compile(valueSchema('document'));
  expect(document.Check({ language: 'zh-Hant', document: {} })).toBe(true);
  for (const content of [
    null,
    'summary',
    { document: {} },
    { language: 'japanese', document: {} },
    { language: 'en', document: 'summary' },
    { language: 'en', document: {}, extra: true },
  ])
    expect(document.Check(content)).toBe(false);
  for (const datatype of ['document', 'media'] as const) {
    expect(() => valueSchema(datatype, { pattern: '^x' })).toThrow();
    expect(() => valueSchema(datatype, { units: ['1'] })).toThrow();
    expect(() => valueSchema(datatype, { integer: true })).toThrow();
  }
});

test('release content properties refuse patterns, targets, units and numeric bounds', () => {
  for (const property of ['schema:abstract', 'schema:image']) {
    for (const member of ['targets', 'units', 'minimum', 'maximum']) {
      const release = structuredClone(bundledRelease);
      Object.assign(release.properties[property]!, {
        [member]: member === 'targets' ? ['schema:Book'] : member === 'units' ? ['1'] : 1,
      });
      expect(validateRelease(release)).toEqual([{ pointer: `/properties/${property}/${member}`, code: 'invalid' }]);
    }
    const release = structuredClone(bundledRelease);
    Object.assign(release.properties[property]!.value, { pattern: '^x' });
    expect(validateRelease(release)).toEqual([{ pointer: `/properties/${property}/value`, code: 'invalid' }]);
  }
});

test('the catalogue compiler admits content types with no patterns, units or numeric bounds', async () => {
  for (const datatype of ['document', 'media'] as const) {
    const input = (extra: object = {}) => ({
      root: 'content.yaml',
      schemas: {
        'content.yaml': JSON.stringify({
          id: 'urn:catalogue:content',
          name: 'content',
          version: '1',
          prefixes: { linkml: 'https://w3id.org/linkml/', ex: 'https://example.org/' },
          imports: ['linkml:types'],
          classes: { Work: { class_uri: 'ex:Work', slots: ['content'] } },
          slots: { content: { slot_uri: 'ex:content', annotations: { datatype }, ...extra } },
        }),
      },
      presentation: { en: JSON.stringify({ types: { 'ex:Work': 'work' }, properties: { 'ex:content': 'content' } }) },
    });
    const release = await compileCatalogue(input());
    expect(release.properties['ex:content']).toMatchObject({ datatype, value: valueSchema(datatype) });
    for (const extra of [
      { pattern: '^x' },
      { minimum_value: 1 },
      { maximum_value: 1 },
      { annotations: { datatype, units: '1' } },
    ]) {
      try {
        await compileCatalogue(input(extra));
        throw new Error('Expected catalogue rejection');
      } catch (error) {
        expect(error).toBeInstanceOf(CatalogueError);
        expect((error as CatalogueError).violations).toEqual(
          expect.arrayContaining([expect.objectContaining({ code: 'invalid' })]),
        );
      }
    }
  }
});
