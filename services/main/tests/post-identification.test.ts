import { expect, test } from 'bun:test';
import { identificationDigest, checkedIdentification, InvalidPostIdentification,
  POST_IDENTIFICATION_COST } from '../src/modules/post/identification-schema.ts';
import { structureProfileFor } from '../src/modules/structure/profiles.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const input = { profile: 'post-identification-v1', placement: { book: id(1), occurrence: id(2) },
  evidence: { kind: 'independent-citation', source: { kind: 'citation', value: 'Collected stories, p. 12' } },
  work: { kind: 'new', type: 'https://schema.org/Book',
    titles: [{ language: 'en', value: 'A story' }, { language: 'zh-Hans', value: '故事' }] }, actingSubject: id(3) };
test('Identification retains evidence, all title languages and exact placement intent', () => {
  const checked = checkedIdentification(input);
  expect(JSON.stringify(checked)).toBe(JSON.stringify(input));
  const reordered = checkedIdentification({ ...input, work: { ...input.work, titles: [...input.work.titles].reverse() } });
  expect(identificationDigest(id(4), checked)).toBe(identificationDigest(id(4), reordered));
  for (const change of [{ evidence: { kind: 'standalone-title' } }, { placement: { book: id(9), occurrence: id(2) } },
    { work: { kind: 'existing', id: id(5) } }]) {
    expect(identificationDigest(id(4), checkedIdentification({ ...input, ...change })))
      .not.toBe(identificationDigest(id(4), checked));
  }
});
test('Identification refuses missing evidence, duplicate language slots and unsupported sources', () => {
  for (const invalid of [
    { ...input, evidence: {} }, { ...input, evidence: { kind: 'automatic' } },
    { ...input, evidence: { kind: 'standalone-title', source: { kind: 'url', value: 'javascript:alert(1)' } } },
    { ...input, work: { ...input.work, titles: [{ language: 'en', value: 'A' }, { language: 'en', value: 'B' }] } },
    { ...input, work: { ...input.work, titles: [] } }, { ...input, moveText: true },
  ]) expect(() => checkedIdentification(invalid)).toThrow(InvalidPostIdentification);
});
test('Identification composes the existing Book profile and publication commands', () => {
  expect(structureProfileFor('book-composition').ownerType).toBe('https://schema.org/Book');
  expect(POST_IDENTIFICATION_COST).toMatchObject({ ownerCommands: 8, placements: 1, relationParticipants: 2, titles: 20 });
});
