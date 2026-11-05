import { expect, test } from 'bun:test';
import { releaseDigest } from '@rezics/definitions';
import { compileCatalogue } from '@rezics/definitions/compile';
import { fixture, legacyProfile } from '../../../../packages/definitions/test/support/library-profiles.ts';
import { presentCopyInventory, type CopyInventoryValue } from '../../src/library/copy-inventory.ts';

test('inventory labels historical IDs through their retained profile pin and separates unavailable meanings', async () => {
  const release = await compileCatalogue(fixture(legacyProfile()));
  const digest = releaseDigest(release);
  const pin = { provenance: 'profile', releaseDigest: digest, acceptingType: 'ex:Child', profileId: 'legacy-fixed-v1' };
  const values: CopyInventoryValue[] = [
    {
      dimension: 'kind',
      id: 'legacy-unspecified',
      copyId: 'copy-kind',
      copyKind: 'legacy-unspecified',
      profilePin: pin,
    },
    { dimension: 'status', id: 'lent', copyId: 'copy-lent', copyKind: 'legacy-unspecified', profilePin: pin },
    { dimension: 'kind', id: 'removed-kind', copyId: 'copy-removed-kind', copyKind: 'removed-kind', profilePin: pin },
    {
      dimension: 'status',
      id: 'removed-status',
      copyId: 'copy-removed-status',
      copyKind: 'legacy-unspecified',
      profilePin: pin,
    },
    {
      dimension: 'kind',
      id: 'unreadable-kind',
      copyId: 'copy-unreadable',
      copyKind: 'unreadable-kind',
      profilePin: null,
    },
  ];

  const inventory = presentCopyInventory(values, new Map([[digest, { digest, release }]]), ['en']);
  expect(inventory.kinds.choices).toEqual([
    { id: 'legacy-unspecified', label: 'Unspecified', labelLanguage: 'en', meaning: 'available' },
    { id: 'removed-kind', label: 'removed-kind', meaning: 'unsupported' },
    { id: 'unreadable-kind', label: 'unreadable-kind', meaning: 'unavailable' },
  ]);
  expect(inventory.statuses.choices).toEqual([
    { id: 'lent', label: 'Lent', labelLanguage: 'en', meaning: 'available' },
    { id: 'removed-status', label: 'removed-status', meaning: 'unsupported' },
  ]);
  expect(presentCopyInventory([], new Map()).kinds).toEqual({ state: 'available', choices: [] });
});

test('an inventory facet becomes unavailable instead of silently truncating retained choices', () => {
  const tooMany = Array.from({ length: 65 }, (_, index): CopyInventoryValue => ({
    dimension: 'kind',
    id: `kind-${index}`,
    copyId: `copy-${index}`,
    copyKind: `kind-${index}`,
    profilePin: null,
  }));
  expect(presentCopyInventory(tooMany, new Map()).kinds).toEqual({ state: 'unavailable', choices: [] });
});
