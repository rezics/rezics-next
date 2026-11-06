import { expect, test } from 'bun:test';

test('TypeList BFF prepares every session and attaches credentials only for selected-realm reads', async () => {
  const binding = await Bun.file(new URL('../src/features/pages/type-list-query.ts', import.meta.url)).text();
  const prepare = binding.indexOf('await prepareSession(request');
  const selected = binding.indexOf('if (hasSelectedRealmTarget(data.target))');
  const authorize = binding.indexOf('authorization = viewerCredential(request)');
  expect(prepare).toBeGreaterThan(0);
  expect(selected).toBeGreaterThan(prepare);
  expect(authorize).toBeGreaterThan(selected);
  expect(binding.slice(prepare, selected)).not.toContain('hasSelectedRealmTarget');
  expect(binding.slice(0, prepare)).not.toContain('viewerCredential(request)');
});
