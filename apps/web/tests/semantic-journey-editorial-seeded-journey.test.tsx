import { expect, test } from 'bun:test';
import { addonProfileId, addonWorkId } from '../src/kernel/fake/catalogue-addon-profile';
import { candidateContext } from '../src/subject/candidates';
import { subjectHref } from '../src/subject/subject-href';
import {
  authoredGlobalVisitHref,
  authoredPublicCorrectionHref,
  authoredPublicVisitUnsupported,
  parseAuthoredPublicVisit,
} from '../src/features/catalogue/authored-public-visit';

const label = 'Cited editorial book';
const publicHref = subjectHref({ id: addonProfileId, label }, 'en').href;
const base = `${publicHref}/authored`;
const observed = { subject: addonProfileId, context: candidateContext, locale: 'en' as const, returnHref: publicHref };

test('authored public return stays independent of synopsis navigation and offers a fresh Global visit', () => {
  const href = authoredPublicCorrectionHref(base, observed);
  const visit = parseAuthoredPublicVisit(new URL(href, 'https://site.test').search, addonProfileId, 'en', base);
  expect(visit).toEqual({
    kind: 'origin',
    origin: { ...observed, returnHref: `${publicHref}#connections` },
  });
  expect(authoredPublicVisitUnsupported(visit)).toBe(false);
  if (visit.kind !== 'origin') throw new Error('Expected an admitted public origin');
  expect(visit.origin.returnHref).toContain('#connections');
  expect(visit.origin.returnHref).not.toContain('subject-summary-reading');

  const mixed = `${href}&via=${encodeURIComponent(`${publicHref}#subject-summary-reading?property=schema%3Aabstract`)}`;
  expect(parseAuthoredPublicVisit(new URL(mixed, 'https://site.test').search, addonProfileId, 'en', base)).toEqual({
    kind: 'invalid',
  });
  expect(
    parseAuthoredPublicVisit(
      `?via=${encodeURIComponent(`${publicHref}#subject-summary-reading?property=schema%3Aabstract`)}`,
      addonProfileId,
      'en',
      base,
    ),
  ).toEqual({ kind: 'legacy' });

  const realmOrigin = {
    ...observed,
    realm: addonWorkId,
    returnHref: `${publicHref}?realm=${addonWorkId}`,
  };
  const realmVisit = parseAuthoredPublicVisit(
    new URL(authoredPublicCorrectionHref(base, realmOrigin), 'https://site.test').search,
    addonProfileId,
    'en',
    base,
  );
  expect(authoredPublicVisitUnsupported(realmVisit)).toBe(true);
  const freshHref = authoredGlobalVisitHref(
    base,
    addonProfileId,
    'en',
    realmVisit.kind === 'origin' ? realmVisit.origin.returnHref : '',
  );
  expect(parseAuthoredPublicVisit(new URL(freshHref, 'https://site.test').search, addonProfileId, 'en', base)).toEqual({
    kind: 'fresh',
    returnHref: `${publicHref}?realm=${addonWorkId}#connections`,
  });
  expect(freshHref).not.toContain('origin=');
  expect(freshHref).not.toContain('via=');
});
