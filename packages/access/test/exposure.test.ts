import { expect, test } from 'bun:test';
import {
  compileExposureCatalogue,
  decideExposure,
  exposureAuthorityActions,
  isExposureGroup,
  isRouteExposureGroup,
  parseExposureDeclaration,
} from '../src/index.ts';

test('route declarations and native opening groups keep their separate admitted sets', () => {
  expect(parseExposureDeclaration('public')).toEqual({ kind: 'public' });
  expect(parseExposureDeclaration('gate:catalogue_import')).toEqual({ kind: 'gate', group: 'catalogue_import' });
  expect(isRouteExposureGroup('feature-name')).toBe(false);
  expect(isExposureGroup('feature-name')).toBe(true);
  expect(exposureAuthorityActions('feature-name')).toEqual(['gate:feature-name', 'gate:any']);
  for (const value of ['gate:feature-name', 'gate:any', 'gate:open', 'gate:close', 'gate:feature1']) {
    expect(() => parseExposureDeclaration(value)).toThrow();
  }
});

test('exposure combines public, current opening, client scope and native gate authority', () => {
  const closed = { kind: 'gate' as const, group: 'feature' };
  const decide = (input: Partial<Parameters<typeof decideExposure>[0]> = {}) =>
    decideExposure({
      exposure: closed,
      open: false,
      actor: 'account',
      clientScope: true,
      gateAuthority: false,
      ...input,
    });
  expect(
    decideExposure({
      exposure: { kind: 'public' },
      open: false,
      actor: 'anonymous',
      clientScope: false,
      gateAuthority: false,
    }),
  ).toMatchObject({ allowed: true, reason: 'public' });
  expect(decide({ actor: 'anonymous' })).toMatchObject({ allowed: false, reason: 'anonymous' });
  expect(decide({ clientScope: false, gateAuthority: true })).toMatchObject({ allowed: false, reason: 'scope' });
  expect(decide()).toMatchObject({ allowed: false, reason: 'gate' });
  expect(decide({ gateAuthority: true })).toMatchObject({ allowed: true, reason: 'gate-authority' });
  expect(decide({ open: true, actor: 'anonymous' })).toMatchObject({ allowed: true, reason: 'open' });
});

test('catalogue facts are normalized, bounded to installed groups and immutable', () => {
  const source = [
    {
      method: 'GET',
      path: '/a',
      operationId: 'a.read',
      action: 'thing:read',
      exposure: { kind: 'gate' as const, group: 'z' },
    },
    {
      method: 'GET',
      path: '/b',
      operationId: 'b.read',
      action: 'thing:read',
      exposure: { kind: 'gate' as const, group: 'a' },
    },
    {
      method: 'GET',
      path: '/c',
      operationId: 'c.read',
      action: 'thing:read',
      exposure: { kind: 'gate' as const, group: 'z' },
    },
  ];
  const catalogue = compileExposureCatalogue(source);
  expect(catalogue.groups).toEqual(['a', 'z']);
  expect(catalogue.digestEntries).toHaveLength(3);
  expect(Object.isFrozen(catalogue)).toBe(true);
  expect(Object.isFrozen(catalogue.groups)).toBe(true);
  expect(Object.isFrozen(catalogue.operations[0])).toBe(true);
});
