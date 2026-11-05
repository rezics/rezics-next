import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { EditorialEntry } from '../src/features/catalogue/editorial-entry';
import {
  identifierInspectionHref,
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

test('the mounted editorial entry and visit address retain the selected public reading', () => {
  const expected = identifierVisitHref(subject, 'en', { context: realmContext, realm });
  const html = renderToStaticMarkup(
    createElement(QueryClientProvider, {
      client: new QueryClient(),
      children: createElement(EditorialEntry, {
        children: null,
        id: subject.id,
        label: subject.label,
        locale: 'en',
        context: realmContext,
        realm,
      }),
    }),
  );
  expect(html).toContain('data-slot="subject-contribute"');
  expect(html).not.toContain('originContext=');
  expect(expected).toContain(`originContext=${realmContext}&originRealm=${realm}`);
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
  const inspected = identifierInspectionHref(review, { property: 'schema:isbn', statement: candidate });
  expect(parseIdentifierCurrentVisit(new URL(inspected, 'https://rezics.test').search)).toMatchObject({
    initialReview: { property: 'schema:isbn', candidate },
    initialInspection: { property: 'schema:isbn', statement: candidate },
  });
  expect(identifierReviewHref(inspected, 'schema:url', candidate)).not.toContain('inspectStatement');
  expect(parseIdentifierCurrentVisit(`?inspectProperty=schema:isbn`)).toBeNull();
  expect(
    parseIdentifierCurrentVisit(
      `?inspectProperty=schema:isbn&inspectStatement=${candidate}&inspectStatement=${candidate}`,
    ),
  ).toBeNull();
  expect(parseIdentifierCurrentVisit(`?${'界'.repeat(700)}`)).toBeNull();
  expect(() => identifierInspectionHref(review, { property: '界'.repeat(256), statement: candidate })).toThrow(
    RangeError,
  );
  expect(parseIdentifierCurrentVisit(`?originContext=${realmContext}&padding=${'x'.repeat(2048)}`)).toBeNull();
});
