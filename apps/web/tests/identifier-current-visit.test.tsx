import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EditorialEntry } from '../src/features/catalogue/editorial-entry';
import {
  identifierOriginHref,
  identifierReviewHref,
  identifierRouteHref,
  identifierVisitHref,
  parseIdentifierCurrentVisit,
} from '../src/features/catalogue/identifier-current-visit';
import { IdentifierOriginChoice } from '../src/features/catalogue/identifier-current-visit-view';
import { candidateContext } from '../src/subject/candidates';

const subject = { id: '00000000-0000-4000-8000-00000000c001', label: 'A multilingual / title' };
const realmContext = '0ac7c5d7-1f67-4d02-8a72-0676044ecb19';
const realm = 'b7d92525-081e-42e1-9cb8-ef72b1492a25';
const candidate = '9f4c6b04-7496-4e14-89bc-41abf931e662';

test('the installed editorial link retains the selected public reading and the public return keeps its Realm selector', () => {
  const expected = identifierVisitHref(subject, 'en', { context: realmContext, realm });
  const html = renderToStaticMarkup(
    createElement(EditorialEntry, {
      children: null,
      id: subject.id,
      label: subject.label,
      locale: 'en',
      context: realmContext,
      realm,
    }),
  );
  expect(html).toContain(`href="${expected.replaceAll('&', '&amp;')}"`);
  expect(parseIdentifierCurrentVisit(new URL(expected, 'https://rezics.test').search)).toMatchObject({
    origin: { context: realmContext, realm, kind: 'realm' },
  });
  expect(
    new URL(identifierOriginHref(subject, 'en', { context: realmContext, realm, kind: 'realm' }), 'https://rezics.test')
      .search,
  ).toBe(`?realm=${realm}`);
});

test('legacy Global visits stay direct, selected non-Global Context waits for an explicit Global choice', () => {
  expect(parseIdentifierCurrentVisit('')).toEqual({});
  expect(parseIdentifierCurrentVisit(`?originContext=${candidateContext}`)).toMatchObject({
    origin: { context: candidateContext, kind: 'global' },
  });
  expect(parseIdentifierCurrentVisit(`?originContext=${realmContext}`)).toMatchObject({
    origin: { context: realmContext, kind: 'unsupported' },
  });

  const html = renderToStaticMarkup(
    createElement(IdentifierOriginChoice, {
      locale: 'en',
      origin: { context: realmContext, realm, realmTitle: 'Example Realm', state: 'current', kind: 'realm' },
      originHref: identifierOriginHref(subject, 'en', { context: realmContext, realm, kind: 'realm' }),
      globalHref: identifierOriginHref(subject, 'en'),
      onChooseGlobal: () => {},
    }),
  );
  expect(html).toContain('Example Realm');
  expect(html).toContain('current Global reading only');
  expect(html).toContain('Open the current Global correction');
  expect(html).not.toContain('ISBN-13');
});

test('bounded visit parsing keeps candidate review separate and rejects malformed or contradictory state', () => {
  const editor = identifierRouteHref('en', subject.id, 'a-title', {
    origin: { context: realmContext, realm, kind: 'realm' },
  });
  const review = identifierReviewHref(editor, 'schema:isbn', candidate);
  expect(parseIdentifierCurrentVisit(new URL(review, 'https://rezics.test').search)).toMatchObject({
    origin: { context: realmContext, realm, kind: 'realm' },
    initialReview: { property: 'schema:isbn', candidate },
  });
  expect(parseIdentifierCurrentVisit(`?originContext=${candidateContext}&originRealm=${realm}`)).toBeNull();
  expect(parseIdentifierCurrentVisit(`?originRealm=${realm}&originRealm=${realm}`)).toBeNull();
  expect(
    parseIdentifierCurrentVisit(
      `?reviewProperty=schema%3Aisbn&candidate=${candidate}&inspectProperty=schema%3Aisbn&inspectStatement=${candidate}`,
    ),
  ).toBeNull();
  expect(parseIdentifierCurrentVisit(`?originContext=${realmContext}&padding=${'x'.repeat(2048)}`)).toBeNull();
});
