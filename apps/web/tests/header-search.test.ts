import { expect, test } from 'bun:test';

const source = async (path: string) => Bun.file(new URL(path, import.meta.url)).text();

test('the header owns the single desktop search field and provides phone search', async () => {
  const shell = await source('../src/shell/shell.tsx');
  expect(shell).toContain('max-w-[40rem]');
  expect(shell).toContain('<ShellSearch />');
  expect(shell).toContain('phoneSearchOpen');
  expect(shell).toContain('md:hidden');
  expect(shell).not.toContain("location.pathname !== '/' && location.pathname !== '/search'");
});

test('search results no longer render their own query field', async () => {
  const search = await source('../src/search/search.tsx');
  expect(search).not.toContain('id="search-query"');
  expect(search).not.toContain('id="search-form"');
  expect(search).toContain('export function ShellSearch()');
});

test('the shelf toolbar no longer renders a second text search box', async () => {
  const toolbar = await source('../../../packages/ui/src/components/shelf-toolbar.tsx');
  expect(toolbar).not.toContain('<Input');
  expect(toolbar).not.toContain('type="search"');
});

test('the header field remains bounded and centered between the logo and controls', async () => {
  const shell = await source('../src/shell/shell.tsx');
  expect(shell).toContain('absolute inset-x-0 mx-auto hidden w-full max-w-[40rem]');
  expect(shell).toContain('pointer-events-auto');
});

test('the phone search opens as a full-screen view using the shared field', async () => {
  const shell = await source('../src/shell/shell.tsx');
  expect(shell).toContain('DialogContent className="inset-0 h-svh w-screen max-w-none');
  expect(shell.match(/<ShellSearch \/>/g)?.length).toBe(2);
});

test('the shared field can render every planned removable scope and clears it with Backspace', async () => {
  const search = await source('../src/search/search.tsx');
  for (const kind of ['Library', 'Collection', 'Realm', 'Zone', 'Agent']) expect(search).toContain(`'${kind}'`);
  expect(search).toContain('ScopeChip');
  expect(search).toContain("event.key === 'Backspace'");
  expect(search).toContain('Remove ${scope.name} scope');
});

test('the header filter control opens the current search filters and reports active conditions', async () => {
  const search = await source('../src/search/search.tsx');
  expect(search).toContain('rezics:open-search-filters');
  expect(search).toContain('activeFilterCount');
  expect(search).toContain('<DrawerContent className="lg:hidden">');
  expect(search).toContain('Collapsible open={filtersOpen}');
  expect(search).not.toContain('DrawerTrigger');
});
