import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  fetchGuideActiveDigest,
  fetchGuideRelease,
  guideEditorField,
  guideReturnTo,
  readGuide,
  definitionGuideHref,
} from '../../src/features/catalogue/definition-guide';
import {
  comparisonAspects,
  comparisonDigestsMatch,
  comparisonFieldRemoved,
  guideCompareValue,
} from '../../src/features/catalogue/definition-guide-comparison';
import { DefinitionGuideContent } from '../../src/features/catalogue/definition-guide-view';
import { definitionGuideFixture, historicalGuideDigest } from '../../src/kernel/fake/definition-guide';
import definitions from '../../src/kernel/recorded/definitions-release.json';
import { m } from '../../src/paraglide/messages.js';

const editor =
  '/en/subjects/00000000-0000-4000-8000-000000000001/a-book/edit?property=rezics%3ArepresentativeEdition&statement=selected#value';
const missingDigest = `sha256:${'ab'.repeat(32)}`;
const currentDigest = definitions.digest;

async function compare(address: Parameters<typeof readGuide>[0], fixture = definitionGuideFixture()) {
  return {
    fixture,
    read: await readGuide(
      address,
      (digest) => fetchGuideRelease(fixture.client, digest),
      () => fixture.transport.directory('en', ''),
      (typeId) => fixture.transport.exact('en', typeId),
      () => fetchGuideActiveDigest(fixture.client),
    ),
  };
}

test('an editor compares pinned and current field definitions without rewriting the draft', async () => {
  const address = {
    type: 'schema:Book',
    property: 'rezics:representativeEdition',
    release: historicalGuideDigest,
    returnTo: editor,
    compare: guideCompareValue,
  } as const;
  const { fixture, read } = await compare(address);
  if (!read.ok || read.pin !== 'compare') throw new Error('Expected comparison');
  expect(comparisonDigestsMatch(read.comparison)).toBe(false);
  expect([...comparisonAspects(read.comparison)]).toEqual(['targets']);
  expect(read.comparison.pinned.status === 'available' && read.comparison.pinned.digest).toBe(historicalGuideDigest);
  expect(read.comparison.current.status === 'available' && read.comparison.current.digest).toBe(currentDigest);
  expect(fixture.calls.filter((call) => call.path.startsWith('/v1/definitionTypes'))).toEqual([]);
  expect(fixture.calls.some((call) => call.path === '/v1/definitions/active')).toBe(true);
  expect(fixture.calls.some((call) => call.path === `/v1/definitions/releases/${historicalGuideDigest}`)).toBe(true);
  expect(fixture.calls.some((call) => call.path === `/v1/definitions/releases/${currentDigest}`)).toBe(true);
  expect(fixture.calls.every((call) => call.method === 'GET')).toBe(true);

  const html = renderToStaticMarkup(
    createElement(DefinitionGuideContent, { address, locale: 'en', read, retry: () => {} }),
  );
  expect(html).toContain(m.guide_pinned_definition({}, { locale: 'en' }));
  expect(html).toContain(m.guide_current_definition({}, { locale: 'en' }));
  expect(html).toContain(historicalGuideDigest);
  expect(html).toContain(currentDigest);
  expect(html).toContain('rezics:AnimeRelease');
  expect(html).toContain(m.guide_changed({}, { locale: 'en' }));
  expect(html).not.toContain(m.guide_no_change({}, { locale: 'en' }));
  expect(html).toContain('/en/subjects/00000000-0000-4000-8000-000000000001/a-book/edit');
  expect(html).toContain('statement=selected');
  expect(html).toContain(m.guide_close_compare({}, { locale: 'en' }));
  expect(
    new URL(definitionGuideHref('en', { ...address, compare: undefined }), 'https://site.test').searchParams.get(
      'returnTo',
    ),
  ).toBe(editor);

  const same = await compare({ ...address, release: currentDigest });
  if (!same.read.ok || same.read.pin !== 'compare') throw new Error('Expected matching comparison');
  expect(comparisonDigestsMatch(same.read.comparison)).toBe(true);
  expect(comparisonAspects(same.read.comparison).size).toBe(0);
  const sameHtml = renderToStaticMarkup(
    createElement(DefinitionGuideContent, {
      address: { ...address, release: currentDigest },
      locale: 'en',
      read: same.read,
      retry: () => {},
    }),
  );
  expect(sameHtml).toContain(m.guide_no_change({}, { locale: 'en' }));
  expect(sameHtml).toContain(currentDigest);

  const missing = await compare({ ...address, release: missingDigest });
  if (!missing.read.ok || missing.read.pin !== 'compare') throw new Error('Expected missing pin comparison');
  expect(missing.read.comparison.pinned).toEqual({ status: 'concealed', digest: missingDigest });
  expect(missing.read.comparison.current.status === 'available' && missing.read.comparison.current.digest).toBe(
    currentDigest,
  );
  const missingHtml = renderToStaticMarkup(
    createElement(DefinitionGuideContent, {
      address: { ...address, release: missingDigest },
      locale: 'en',
      read: missing.read,
      retry: () => {},
    }),
  );
  const pinnedColumn = missingHtml.slice(
    missingHtml.indexOf(m.guide_pinned_definition({}, { locale: 'en' })),
    missingHtml.indexOf(m.guide_current_definition({}, { locale: 'en' })),
  );
  expect(pinnedColumn).toContain(missingDigest);
  expect(pinnedColumn).toContain(m.guide_pinned_unavailable({}, { locale: 'en' }));
  expect(pinnedColumn).not.toContain(currentDigest);
  expect(pinnedColumn).not.toContain('rezics:AnimeRelease');
  expect(missingHtml).toContain(currentDigest);
  expect(missingHtml).toContain(m.guide_current_definition({}, { locale: 'en' }));

  if (read.comparison.pinned.status !== 'available') throw new Error('Expected pinned release');
  const pinned = { ok: true as const, pin: 'pinned' as const, release: read.comparison.pinned.release };
  const opened = {
    type: 'schema:Book',
    property: 'rezics:representativeEdition',
    release: historicalGuideDigest,
    returnTo: editor,
  };
  expect(guideEditorField(opened, 'en')).toBe(true);
  expect(guideReturnTo('https://elsewhere.test/en/catalogue/new', 'en')).toBeUndefined();
  const offer = renderToStaticMarkup(
    createElement(DefinitionGuideContent, { address: opened, locale: 'en', read: pinned, retry: () => {} }),
  );
  expect(offer).toContain(m.guide_compare({}, { locale: 'en' }));
  expect(offer).toContain(`compare=${guideCompareValue}`);
  expect(offer).toContain('statement=selected');
  const browsing = renderToStaticMarkup(
    createElement(DefinitionGuideContent, {
      address: { type: 'schema:Book', property: 'rezics:representativeEdition', release: historicalGuideDigest },
      locale: 'en',
      read: pinned,
      retry: () => {},
    }),
  );
  expect(browsing).not.toContain(m.guide_compare({}, { locale: 'en' }));

  const labelsOnly = await compare({
    type: 'schema:Recipe',
    property: 'schema:cookTime',
    release: historicalGuideDigest,
    compare: guideCompareValue,
  });
  if (!labelsOnly.read.ok || labelsOnly.read.pin !== 'compare') throw new Error('Expected cookTime comparison');
  expect(comparisonAspects(labelsOnly.read.comparison).size).toBe(0);
  expect(comparisonFieldRemoved(labelsOnly.read.comparison)).toBe(false);
});
