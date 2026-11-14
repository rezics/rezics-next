import { expect, test } from 'bun:test';
import { Compile } from 'typebox/compile';
import { platformRegistry, validateZoneConfiguration, type ZoneConfiguration } from '@rezics/composition';
import { ZoneCreateInputSchema, ZoneConfigureInputSchema, ZonePublicSchema } from '../../src/zones/contract.ts';

test('Zone create configure and public schemas retain one authored primary name and optional translations', () => {
  const configuration: ZoneConfiguration = {
    primaryLanguage: 'ja',
    labels: { ja: '本棚' },
    pages: [{ route: '', document: { root: { props: {} }, content: [] } }],
    scope: [],
  };
  const create = Compile(ZoneCreateInputSchema());
  const configure = Compile(ZoneConfigureInputSchema());
  const check = (value: unknown) => validateZoneConfiguration(platformRegistry, value, { filters: new Set() });
  for (const labels of [{ ja: '本棚' }, { ja: '本棚', de: 'Bücher' }]) {
    const next = { ...configuration, labels };
    expect(create.Check({ configuration: next, mounts: [], visibility: 'private' })).toBe(true);
    expect(configure.Check({ configuration: next, mounts: [] })).toBe(true);
    expect(check(next)).toEqual([]);
  }
  // The envelope schema admits partial maps; the resource validator enforces primary presence.
  expect(check({ ...configuration, labels: {} })).toContainEqual({ pointer: '/labels/ja', code: 'invalid' });
  expect(configure.Check({ configuration: { ...configuration, primaryLanguage: 'it' }, mounts: [] })).toBe(false);
  expect(
    configure.Check({ configuration: { ...configuration, labels: { ja: '本棚', it: 'Libri' } }, mounts: [] }),
  ).toBe(false);
  const shell = {
    id: '019a1b2c-3d4e-7f00-8a00-6a0010000001',
    revision: '1',
    primaryLanguage: 'ja',
    labels: { ja: '本棚' },
    visibility: 'public',
    appearance: {},
    navigation: [{ route: '' }],
  };
  const publicShell = Compile(ZonePublicSchema());
  expect(publicShell.Check(shell)).toBe(true);
  expect(publicShell.Check({ ...shell, primaryLanguage: null, labels: { en: 'Books' } })).toBe(true);
  expect(publicShell.Check({ ...shell, primaryLanguage: null, labels: {} })).toBe(true);
  expect(publicShell.Check({ ...shell, primaryLanguage: null, configuration })).toBe(false);
  const withheld = { ...configuration, primaryLanguage: null };
  expect(create.Check({ configuration: withheld, mounts: [], visibility: 'private' })).toBe(false);
  expect(configure.Check({ configuration: withheld, mounts: [] })).toBe(false);
  expect(check(withheld)).toContainEqual({ pointer: '/primaryLanguage', code: 'invalid' });
});
