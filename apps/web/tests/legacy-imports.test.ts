import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = join(import.meta.dir, '..', 'src');
const read = (file: string) => readFileSync(join(source, file), 'utf8');

/** Site components that live in the UI package outside the shadcn set, plus the class-name helper and stylesheet. */
const siteComponents = new Set([
  'utils',
  'styles.css',
  'cover',
  'cover-card',
  'entity-picker',
  'progress-row',
  'reactions',
  'content-actions',
  'document-body',
  'report-dialog',
]);

function uiImports(code: string, loader: 'ts' | 'tsx'): string[] {
  return new Bun.Transpiler({ loader })
    .scanImports(code)
    .map((item) => item.path)
    .filter((path) => path.startsWith('@rezics/ui/'));
}

test('no site source imports a legacy @rezics/ui component that has a shadcn counterpart', () => {
  const files = [...new Bun.Glob('**/*.{ts,tsx}').scanSync({ cwd: source })];
  expect(files.length).toBeGreaterThan(10);
  const legacy = files.flatMap((file) =>
    uiImports(read(file), file.endsWith('.tsx') ? 'tsx' : 'ts')
      .map((path) => path.slice('@rezics/ui/'.length))
      .filter((name) => !name.startsWith('shadcn/') && !siteComponents.has(name))
      .map((name) => `${file}: @rezics/ui/${name}`),
  );
  expect(legacy).toEqual([]);
  // Nothing under the site reaches for Ark UI directly either.
  const ark = files.filter((file) => /@ark-ui\//.test(read(file)));
  expect(ark).toEqual([]);
  // The site components kept are still there.
  for (const name of siteComponents)
    if (name !== 'utils' && name !== 'styles.css')
      expect(
        existsSync(join(import.meta.dir, '..', '..', '..', 'packages', 'ui', 'src', 'components', `${name}.tsx`)),
      ).toBe(true);
});

test('the search typeahead keeps its keyboard behaviour and suggestions with covers on the shadcn combobox', () => {
  const code = read('search/search.tsx');
  expect(uiImports(code, 'tsx')).toContain('@rezics/ui/shadcn/combobox');
  expect(uiImports(code, 'tsx')).not.toContain('@rezics/ui/combobox');
  // Suggestions come from the server, not from filtering a local list.
  expect(code).toMatch(/<Combobox[\s\S]*?filter=\{null\}/);
  // Each suggestion shows its cover at the extra-small size, its title, its type and its year.
  expect(code).toMatch(/<Cover[\s\S]*?size="xs"/);
  expect(code).toContain('item.label');
  expect(code).toMatch(/<SubjectMeta[\s\S]*?type=\{typeName\}[\s\S]*?year=\{hitYear\(/);
  // Choosing a suggestion opens it; Enter on text that no suggestion has taken submits the query.
  expect(code).toMatch(/onValueChange=/);
  expect(code).toMatch(/event\.key === 'Enter' && !event\.currentTarget\.getAttribute\('aria-activedescendant'\)/);
  // Without JavaScript the box is a plain GET form to the locale's search page.
  expect(code).toMatch(/<form[^>]*method="get"[^>]*action=\{`\/\$\{locale\}\/search`\}/);
  expect(code).toMatch(/<ComboboxInput[\s\S]*?name="q"/);
});

test("bylines show the author's avatar or initials through the shadcn avatar", async () => {
  const code = read('threads/byline.tsx');
  const imports = uiImports(code, 'tsx');
  expect(imports).toContain('@rezics/ui/shadcn/avatar');
  expect(imports).not.toContain('@rezics/ui/avatar-initials');
  expect(code).toMatch(/<Avatar[\s\S]*?<AvatarFallback>[\s\S]*?initials\(/);

  const { initials } = await import('../src/threads/initials.ts');
  expect(initials('Alice Brown')).toBe('AB');
  expect(initials('alice')).toBe('A');
  expect(initials('élodie')).toBe('É');
  expect(initials('陈丹尼')).toBe('陈');
  expect(initials('김민지')).toBe('김');
  expect(initials('Daniel Chen 陈丹尼')).toBe('DC');
  expect(initials('Daniel 陈丹尼')).toBe('D');
  expect(initials('Lin·Mei')).toBe('LM');
  expect(initials('  ')).toBe('?');
  expect(initials('@@')).toBe('?');
  expect(initials('42')).toBe('4');
});
