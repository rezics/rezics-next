import { expect, test } from 'bun:test';
import { frameChips, sameProjection, subjectOf, withFrame, withoutFrame, type FrameCandidate } from '../features/scoped-rating/frames.ts';
import * as fixture from '../features/scoped-rating/fixtures.ts';

const [e1, e2] = fixture.episodes as [FrameCandidate, FrameCandidate];
const canon = fixture.continuities[0]!;

test('choosing another place of the same kind replaces it, since Main allows one coordinate per dimension', () => {
  expect(withFrame([e1, canon], e2).map(frame => frame.iri)).toEqual([canon.iri, e2.iri]);
  expect(withFrame([e1], e1)).toEqual([e1]);
  expect(withoutFrame([e1, canon], e1.iri)).toEqual([canon]);
});

test('the same subject within the same frames is one place, whatever order they were chosen in', () => {
  const a = { subject: fixture.subject.iri, frames: [e1.iri, canon.iri] };
  expect(sameProjection(a, { subject: fixture.subject.iri, frames: [canon.iri, e1.iri] })).toBe(true);
  expect(sameProjection(a, { subject: fixture.subject.iri, frames: [e1.iri] })).toBe(false);
  expect(sameProjection(a, { subject: fixture.iri('c002'), frames: [e1.iri, canon.iri] })).toBe(false);
});

test('chips come from the summary parts in frame order and link each place to its own page', () => {
  const read = fixture.projectionRead(fixture.iri('1a90'), fixture.subject.iri, [e1.iri, canon.iri]);
  const chips = frameChips(read.summary ?? undefined, 'en');
  expect(chips.map(chip => chip.name.value)).toEqual([e1.name.value, canon.name.value]);
  expect(chips.every(chip => chip.href.startsWith('/en/e/'))).toBe(true);
  expect(chips[0]?.kind).toBe('part');
  expect(subjectOf(read.summary ?? undefined, 'en')?.name.value).toBe('Elizabeth Bennet');
});

test('a place the reader has not reached has no name, subject or chips to give the story away', () => {
  const hidden = fixture.projectionRead(fixture.iri('1a91'), fixture.subject.iri, [e1.iri], true);
  expect(frameChips(hidden.summary ?? undefined, 'en')).toEqual([]);
  expect(subjectOf(hidden.summary ?? undefined, 'en')).toBeNull();
  expect(JSON.stringify(hidden)).not.toContain(e1.name.value);
});
