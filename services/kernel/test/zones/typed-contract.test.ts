import { expect, test } from 'bun:test';
import { Compile } from 'typebox/compile';
import { ZonePageRequestSchema, ZonePublicSchema } from '../../src/zones/contract.ts';

const id = '019a1b2c-3d4e-7f00-8a00-6a0010000001';
test('Zone page request is a closed route-or-subject target with the shared view vocabulary', () => {
  const check = Compile(ZonePageRequestSchema);
  expect(check.Check({ target: { route: '' } })).toBe(true);
  expect(check.Check({ target: { subject: id, view: 'overview' }, languages: ['en'] })).toBe(true);
  expect(check.Check({ target: { route: '', subject: id } })).toBe(false);
  expect(check.Check({ target: { account: id } })).toBe(false);
  expect(check.Check({ target: { subject: id, view: 'arbitrary-script' } })).toBe(false);
  expect(check.Check({ target: { route: '' }, ownerId: id })).toBe(false);
});
test('public Zone schema cannot serialize private owner mount or scope descriptors', () => {
  const check = Compile(ZonePublicSchema);
  const visible = {
    id,
    revision: '1',
    labels: { en: 'A site' },
    visibility: 'public',
    appearance: { density: 'compact', surface: 'cards' },
    navigation: [{ route: '' }],
  };
  expect(check.Check(visible)).toBe(true);
  expect(check.Check({ ...visible, labels: {} })).toBe(true);
  expect(check.Check({ ...visible, ownerId: id })).toBe(false);
  expect(check.Check({ ...visible, mounts: [id] })).toBe(false);
  expect(check.Check({ ...visible, scope: ['private-predicate'] })).toBe(false);
  expect(check.Check({ ...visible, appearance: { css: 'secret' } })).toBe(false);
  expect(check.Check({ ...visible, appearance: { density: 'invented' } })).toBe(false);
  expect(check.Check({ ...visible, revision: 1 })).toBe(false);
});
