import { expect, test } from 'bun:test';
import { PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { GLOBAL } from '../../../../specs/imports-identity-driver.ts';

test('imports identity fixture uses the sole authoritative platform resource', () => {
  expect(GLOBAL).toBe(PLATFORM_RESOURCE);
  expect(GLOBAL).toEqual({ route: 0, id: '00000000-0000-8000-8000-000000000000' });
});
