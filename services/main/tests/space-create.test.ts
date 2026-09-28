import { expect, test } from 'bun:test';
import { InvalidSpaceInput, spaceCreationDigest } from '../src/modules/space/create.ts';

const actor = 'https://rezics.com/id/00000000-0000-8000-8000-000000000412';
const one = 'https://rezics.com/id/00000000-0000-8000-8000-000000000413';
const two = 'https://rezics.com/id/00000000-0000-8000-8000-000000000414';

test('Community creation binds its handle and Concept set to the idempotent intent', () => {
  const input = { name: 'Readers', actingSubject: actor, handle: 'readers-club', topics: [one, two] };
  expect(spaceCreationDigest(input)).toBe(spaceCreationDigest({ ...input, topics: [two, one] }));
  expect(spaceCreationDigest(input)).not.toBe(spaceCreationDigest({ ...input, handle: 'another-club' }));
  expect(spaceCreationDigest(input)).not.toBe(spaceCreationDigest({ ...input, topics: [one] }));
  expect(() => spaceCreationDigest({ ...input, topics: [one, one] })).toThrow(InvalidSpaceInput);
  expect(() => spaceCreationDigest({ ...input, handle: 'Bad Handle' })).toThrow(InvalidSpaceInput);
});
