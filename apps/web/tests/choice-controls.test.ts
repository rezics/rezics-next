import { expect, test } from 'bun:test';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NativeCheckbox } from '@rezics/ui/native-checkbox';

const root = join(import.meta.dir, '..', '..', '..');

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return /\.[jt]sx?$/.test(entry.name) ? [path] : [];
    }),
  );
  return nested.flat();
}

test('only NativeCheckbox renders a native checkbox or radio input', async () => {
  const files = [
    ...(await sourceFiles(join(root, 'apps/web/src'))),
    ...(await sourceFiles(join(root, 'packages/ui/src/components'))),
  ];
  const violations = [];
  for (const file of files) {
    if (file.endsWith('/native-checkbox.tsx')) continue;
    const source = await readFile(file, 'utf8');
    if (
      /<input\b[^>]*\btype\s*=\s*['"](?:checkbox|radio)['"]|<input\s+type\s*=\s*\{\s*['"](?:checkbox|radio)['"]/.test(
        source,
      )
    ) {
      violations.push(file.slice(root.length + 1));
    }
  }
  expect(violations).toEqual([]);
});

test('NativeCheckbox keeps native attributes and draws the checked state with shared tokens', () => {
  const html = renderToStaticMarkup(
    createElement(NativeCheckbox, {
      checked: true,
      disabled: true,
      form: 'facet-form',
      name: 'f.genre',
      value: 'fiction',
      'aria-label': 'Fiction',
    }),
  );
  expect(html).toContain('type="checkbox"');
  expect(html).toContain('checked=""');
  expect(html).toContain('disabled=""');
  expect(html).toContain('form="facet-form"');
  expect(html).toContain('name="f.genre"');
  expect(html).toContain('value="fiction"');
  expect(html).toContain('appearance-none');
  expect(html).toContain('checked:bg-primary');
  expect(html).toContain('checked:after:border-primary-foreground');
});

test('choice-control call sites use shared controls and native facets retain GET form fields', async () => {
  const cases: Record<string, RegExp[]> = {
    'packages/ui/src/components/menu.tsx': [/RadioGroup/, /RadioGroupItem/, /onValueChange/],
    'apps/web/src/library/collection-page.tsx': [
      /RadioGroup/,
      /RadioGroupItem/,
      /FieldSet/,
      /FieldLegend/,
      /FieldLabel/,
      /Checkbox/,
    ],
    'packages/ui/src/components/shelf-list.tsx': [/Checkbox/, /FieldLabel/],
    'packages/ui/src/components/shelf-table.tsx': [/Checkbox/, /FieldLabel/],
    'apps/web/src/threads/review-fields.tsx': [/Checkbox/, /FieldLabel/],
    'apps/web/src/search/search.tsx': [/NativeCheckbox/, /name=/, /value=/],
    'packages/ui/src/components/document-body.tsx': [/NativeCheckbox/, /disabled/],
  };
  for (const [path, patterns] of Object.entries(cases)) {
    const source = await readFile(join(root, path), 'utf8');
    for (const pattern of patterns) expect(source, `${path} should include ${pattern}`).toMatch(pattern);
  }
});
