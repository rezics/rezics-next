import { expect, test } from 'bun:test';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const root = join(import.meta.dir, '..', '..');

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
    if (/<input\b[^>]*\btype\s*=\s*['"](?:checkbox|radio)['"]|<input\s+type\s*=\s*\{\s*['"](?:checkbox|radio)['"]/.test(source)) {
      violations.push(file.slice(root.length + 1));
    }
  }
  expect(violations).toEqual([]);
});

test('choice-control call sites use shared controls and native facets retain GET form fields', async () => {
  const cases: Record<string, RegExp[]> = {
    'packages/ui/src/components/menu.tsx': [/RadioGroup/, /RadioGroupItem/, /onValueChange/],
    'apps/web/src/library/collection-page.tsx': [/RadioGroup/, /RadioGroupItem/, /FieldSet/, /FieldLegend/, /FieldLabel/, /Checkbox/],
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
