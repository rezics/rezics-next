import { expect, test } from 'bun:test';
import { frameChips, sameProjection, subjectOf, withFrame, withoutFrame, type FrameCandidate } from '../features/scoped-rating/frames.ts';
import * as fixture from '../features/scoped-rating/fixtures.ts';
import { localizedPath } from '../i18n/locale.ts';
import { resourceHref } from '../features/address/path.ts';

const [e1, e2] = fixture.episodes as [FrameCandidate, FrameCandidate];
const canon = fixture.continuities[0]!;

test('choosing another place of the same kind replaces it, since Main allows one coordinate per slot', () => {
  expect(withFrame([e1, canon], e2).map(frame => frame.iri)).toEqual([canon.iri, e2.iri]);
  expect(withFrame([e1], e1)).toEqual([e1]);
  expect(withoutFrame([e1, canon], e1.iri)).toEqual([canon]);
});

const work = fixture.workIri;
const otherWork = fixture.iri('c0df');
const inWork = (frame: FrameCandidate, of: string): FrameCandidate => ({ ...frame, work: of });
const release: FrameCandidate = { iri: fixture.iri('f1'), dimension: 'release', work, name: e1.name };
const edition: FrameCandidate = { iri: fixture.iri('f2'), dimension: 'realization', work, name: e1.name };
const theWork: FrameCandidate = { iri: work, dimension: 'work', name: e1.name };
const iris = (frames: readonly FrameCandidate[]) => frames.map(frame => frame.iri);

test('a release and an edition share a slot, so choosing one replaces the other', () => {
  expect(iris(withFrame([release], edition))).toEqual([edition.iri]);
  expect(iris(withFrame([inWork(e1, work), release], edition))).toEqual([e1.iri, edition.iri]);
});

test('a Work may stay beside one of its own episodes, but no slot holds two of anything else', () => {
  expect(iris(withFrame([theWork], inWork(e1, work)))).toEqual([work, e1.iri]);
  expect(iris(withFrame([inWork(e1, work)], theWork))).toEqual([e1.iri, work]);
  // Another episode replaces the episode, and the Work stays.
  expect(iris(withFrame([theWork, inWork(e1, work)], inWork(e2, work)))).toEqual([work, e2.iri]);
});

test('a coordinate in another Work replaces those in the first, and a continuity is kept, so Main never sees two Works', () => {
  expect(iris(withFrame([inWork(e1, work), release, canon], inWork(e2, otherWork)))).toEqual([canon.iri, e2.iri]);
  expect(iris(withFrame([theWork, canon], inWork(e2, otherWork)))).toEqual([canon.iri, e2.iri]);
  // A coordinate whose Work is unknown is never taken for another Work's.
  const unplaced: FrameCandidate = { iri: fixture.iri('f3'), dimension: 'release', name: e1.name };
  expect(iris(withFrame([unplaced], inWork(e2, otherWork)))).toEqual([unplaced.iri, e2.iri]);
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
  expect(chips.every(chip => chip.href.startsWith(localizedPath(resourceHref('/e/', ''), 'en')))).toBe(true);
  expect(chips[0]?.kind).toBe('part');
  expect(subjectOf(read.summary ?? undefined, 'en')?.name.value).toBe('Elizabeth Bennet');
});

test('a place the reader has not reached has no name, subject or chips to give the story away', () => {
  const hidden = fixture.projectionRead(fixture.iri('1a91'), fixture.subject.iri, [e1.iri], true);
  expect(frameChips(hidden.summary ?? undefined, 'en')).toEqual([]);
  expect(subjectOf(hidden.summary ?? undefined, 'en')).toBeNull();
  expect(JSON.stringify(hidden)).not.toContain(e1.name.value);
});
