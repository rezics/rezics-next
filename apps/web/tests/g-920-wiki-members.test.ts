import { expect, test } from 'bun:test';
import { readMembers } from '../features/wiki/members.ts';
import { seedTypes, clearTypes } from '../features/catalogue/types.ts';
import { admittedTypes } from '../../../services/main/src/modules/types/registry.ts';

test('G-920: web index members consume projected names without a member page read', async () => {
  seedTypes({ profile: 'types-v1', digest: 'g-920', types: admittedTypes });
  try {
    const members = await readMembers(
      { zone: 'zone', ref: 'wiki', segments: ['places'], choice: { kind: 'all' }, main: 'all' },
      'places',
      [
        {
          id: 'https://rezics.com/id/00000000-0000-4000-8000-000000000001',
          types: ['https://schema.org/Place'],
          name: { value: 'Longbourn', language: 'en', direction: 'ltr', basis: 'requested' },
          inZone: true,
        },
      ],
      'en',
    );
    expect(members).toHaveLength(1);
    expect(members[0]!.name.value).toBe('Longbourn');
    expect(members[0]!.kind).toBe('Place');
  } finally {
    clearTypes();
  }
});
