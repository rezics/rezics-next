import { expect, test } from 'bun:test';
import { bundledRelease, bundledSources } from '../src/bundled.ts';
import { validateRelease } from '../src/index.ts';
import { compileCatalogue, CatalogueError } from '../src/compile.ts';
import { checkStatementInput } from '../src/validate.ts';

test('sourceOrConsent disclosure validates and any other disclosure value is refused', async () => {
  const property = bundledRelease.properties['rezics:penNameOf']!;
  expect(property.disclosure).toBe('sourceOrConsent');
  expect(property.targets).toEqual(['schema:Organization', 'schema:Person']);
  expect(property.relation).toEqual({
    group: 'association',
    inverse: 'rezics:penNames',
    order: 'name',
    inverseLabels: {
      de: 'Pseudonyme',
      en: 'pen names',
      es: 'seudónimos',
      fr: 'pseudonymes',
      ja: '筆名',
      ko: '필명',
      'zh-Hans': '笔名',
      'zh-Hant': '筆名',
    },
  });
  expect(Object.keys(property.descriptions!).sort()).toEqual(Object.keys(property.labels).sort());
  expect(validateRelease(bundledRelease)).toEqual([]);
  const invalid = structuredClone(bundledRelease) as any;
  invalid.properties['rezics:penNameOf'].disclosure = 'public';
  expect(validateRelease(invalid)).toEqual([{ pointer: '/properties/rezics:penNameOf/disclosure', code: 'invalid' }]);
  const source = bundledSources();
  source.schemas['core.yaml'] = source.schemas['core.yaml']!.replace(
    'disclosure: sourceOrConsent',
    'disclosure: public',
  );
  await expect(compileCatalogue(source)).rejects.toBeInstanceOf(CatalogueError);
  expect(
    checkStatementInput(
      {
        property: { id: 'rezics:penNameOf' },
        value: { type: 'value', content: '00000000-0000-8000-8000-000000000001' },
      },
      bundledRelease,
    ).violations,
  ).toEqual([]);
});
