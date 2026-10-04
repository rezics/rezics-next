import { describe, expect, test } from 'bun:test';
import { uuidToSid } from '@rezics/model/address';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { authorHref } from '../features/author/route.ts';
import { destinationOf } from '../features/catalogue-intake/intake.ts';
import { classics } from '../features/catalogue/fixtures.ts';
import {
  conceptHref,
  conceptPath,
  type ConceptState,
  withValue,
} from '../features/concept/state.ts';
import { continueHref, entityHref, standaloneHrefFor } from '../features/entity-page/route.ts';
import { communityHref, threadPath } from '../features/feed/discussion.ts';
import { FeedProvider } from '../features/feed/feed-context.tsx';
import { everyKind, post } from '../features/feed/fixtures.ts';
import { messages } from '../features/feed/messages.ts';
import { WorkAttachment } from '../features/feed/post-row.tsx';
import { subjectOf } from '../features/manage/queue-subject.ts';
import { profileHref } from '../features/profile/route.ts';
import { discussionTarget } from '../features/safety/report.ts';
import type { TypeaheadItem } from '../features/search/suggest.ts';
import { suggestionHref } from '../features/search/typeahead.tsx';

const uuid = '0199a0fe-0b21-7000-8000-123456789abc';
const iri = `https://rezics.com/id/${uuid}`;
const sid = uuidToSid(uuid);
const workAddress = { prefix: '/w/' as const, key: '春の物語', suffixSource: 'Spring story' };
// ast-grep-ignore: web-links-use-address -- Independent canonical expectation verifies the address builders without calling them again.
const encodedWork = '/w/%E6%98%A5%E3%81%AE%E7%89%A9%E8%AA%9E';

describe('G-950 durable links across shared, feed, profile and catalogue surfaces', () => {
  test('entity and catalogue links retain every identity bit instead of UUID paths', () => {
    // ast-grep-ignore: web-links-use-address -- Independent canonical expectation verifies the address builders without calling them again.
    expect(entityHref(iri)).toBe(`/e/${sid}`);
    // ast-grep-ignore: web-links-use-address -- Independent canonical expectation verifies the address builders without calling them again.
    expect(conceptPath(iri)).toBe(`/concepts/${sid}`);
    // ast-grep-ignore: web-links-use-address -- Independent canonical expectation verifies the address builders without calling them again.
    expect(classics[0]!.href).toBe(`/w/${uuidToSid(classics[0]!.id.slice(-36))}`);
    // ast-grep-ignore: web-links-use-address -- Independent canonical expectation verifies the address builders without calling them again.
    expect(post(1).links.target).toBe(`/w/${uuidToSid(post(1).target.id.slice(-36))}`);
    // ast-grep-ignore: web-links-use-address -- Independent canonical expectation verifies the address builders without calling them again.
    expect(subjectOf(iri, { works: {}, chapters: {} }, 'Unknown').href).toBe(`/w/${sid}`);
  });

  test('Main canonical addresses win over a link host and its identity fallback', () => {
    expect(entityHref(workAddress)).toBe(encodedWork);
    const hrefFor = standaloneHrefFor({}, entityHref(iri));
    const link = {
      kind: 'resource' as const,
      iri,
      base: 'work' as const,
      type: null,
      address: workAddress,
    };
    expect(hrefFor(link)).toBe(encodedWork);
    const rtlLink = {
      ...link,
      address: { prefix: '/e/' as const, key: sid, suffixSource: 'كتاب جديد' },
    };
    expect(hrefFor(rtlLink))
      // ast-grep-ignore: web-links-use-address -- Independent canonical expectation verifies the address builders without calling them again.
      .toBe(`/e/${sid}-%D9%83%D8%AA%D8%A7%D8%A8-%D8%AC%D8%AF%D9%8A%D8%AF`);
  });

  test('profile names, native handles and Main policy preserve views and opaque cursors', () => {
    // ast-grep-ignore: web-links-use-address -- Independent canonical expectation verifies the address builders without calling them again.
    expect(authorHref({ kind: 'agent', handle: `agent-${uuid}` })).toBe(`/a/${sid}`);
    expect(profileHref('lin_mei', { kind: 'shelf', status: 'reading' }, 'a/b+?'))
      // ast-grep-ignore: web-links-use-address -- Independent canonical expectation verifies the address builders without calling them again.
      .toBe('/@lin_mei/shelves/reading?cursor=a%2Fb%2B%3F');
    const address = { prefix: '/a/' as const, key: sid, suffixSource: 'Lin Mei' };
    expect(profileHref({ handle: 'old_handle', address }, { kind: 'works' })).toBe(
      // ast-grep-ignore: web-links-use-address -- Independent canonical expectation verifies the address builder without calling it again.
      `/a/${sid}-lin-mei/works`,
    );
    // ast-grep-ignore: web-links-use-address -- Independent canonical expectation verifies the address builders without calling them again.
    expect(authorHref({ kind: 'agent', handle: 'old_handle', address })).toBe(`/a/${sid}-lin-mei`);
    expect(authorHref({ kind: 'external', key: '/authors/OL21594A' })).toBe(
      '/authors/open-library/OL21594A',
    );
  });

  test('community name policy and SID discussions keep the same report target', () => {
    // ast-grep-ignore: web-links-use-address -- Independent canonical expectation verifies the address builders without calling them again.
    expect(communityHref(iri)).toBe(`/r/${sid}`);
    // ast-grep-ignore: web-links-use-address -- Independent canonical expectation verifies the address builders without calling them again.
    expect(communityHref(iri, 'fiction')).toBe('/r/fiction');
    expect(communityHref({ prefix: '/z/', key: 'new-community', suffixSource: '' }, 'old-community'))
      // ast-grep-ignore: web-links-use-address -- Independent canonical expectation verifies the address builders without calling them again.
      .toBe('/r/new-community');
    const thread = threadPath(communityHref(iri, 'fiction'), iri);
    // ast-grep-ignore: web-links-use-address -- Independent canonical expectation verifies the address builders without calling them again.
    expect(thread).toBe(`/r/fiction/discussions/${sid}`);
    for (const target of [
      thread,
      `${thread}-old-title#reply`,
      // ast-grep-ignore: web-links-use-address -- Independent canonical expectation verifies the address builder without calling it again.
      `/en/r/fiction/discussions/${uuid}?cursor=next`,
    ]) {
      expect(discussionTarget(target)).toBe(iri);
    }
    for (const target of [
      // ast-grep-ignore: web-links-use-address -- Malformed discussion input verifies rejection rather than navigation.
      '/r/fiction/discussions/not-an-id',
      // ast-grep-ignore: web-links-use-address -- Malformed discussion input verifies rejection rather than navigation.
      '/r/fiction/discussions/%ZZ',
      // ast-grep-ignore: web-links-use-address -- Independent canonical expectation verifies the address builder without calling it again.
      `/w/${sid}`,
    ]) {
      expect(discussionTarget(target)).toBeNull();
    }
  });

  test('concept conditions and entity pagination retain the canonical page and meaningful selections', () => {
    const state: ConceptState = {
      concept: uuid,
      address: { prefix: '/concepts/', key: sid, suffixSource: 'Fantasy' },
      scope: { kind: 'global' },
      include: [],
      exclude: [],
      match: 'all',
    };
    const other = '0199a0fe-0b21-7000-8000-123456789abd';
    expect(conceptHref(withValue(state, other, 'include'))).toBe(
      // ast-grep-ignore: web-links-use-address -- Independent canonical expectation verifies the address builder without calling it again.
      `/concepts/${sid}-fantasy?include=${other}`,
    );
    expect(continueHref(encodedWork, { discussion: 'read+next' }, 'statements', 's/next')).toBe(
      `${encodedWork}?discussion=read%2Bnext&statements=s%2Fnext#statements`,
    );
    expect(destinationOf('/v1/works/{work}/realizations/{realization}', iri)).toBe(
      // ast-grep-ignore: web-links-use-address -- Independent canonical expectation verifies the address builder without calling it again.
      `/w/${sid}/edit/editions`,
    );
  });

  test('typeahead opens Main named Works and keeps credited-name searches', () => {
    const item: TypeaheadItem = {
      work: iri,
      mainVersion: iri,
      title: { value: 'Spring story', language: 'en', direction: 'ltr', basis: 'requested' },
      cover: { kind: 'fallback', policy: 'avatar-fallback-v1', key: sid, resourceType: 'work' },
      types: [],
      authors: [],
      matchedField: 'title',
      matchedText: 'Spring story',
      matchedLanguage: 'en',
    };
    // ast-grep-ignore: web-links-use-address -- Independent canonical expectation verifies the address builders without calling them again.
    expect(suggestionHref(item)).toBe(`/w/${sid}`);
    const named = { ...item, address: workAddress };
    expect(suggestionHref(named)).toBe(encodedWork);
    expect(suggestionHref({ ...item, matchedField: 'credit', matchedText: 'Jane Austen' })).toBe(
      '/search?q=Jane%20Austen',
    );
  });

  test('a rendered feed Work attachment consumes Main policy instead of rebuilding its UUID link', () => {
    const work = {
      id: iri,
      address: workAddress,
      title: post(1).target.title,
      cover: post(1).target.cover,
      types: [] as string[],
      byline: null,
    };
    const render = (address = workAddress) =>
      renderToStaticMarkup(
        createElement(FeedProvider, {
          locale: 'en',
          messages,
          now: 0,
          signedIn: false,
          actingSubject: null,
          signInHref: '/sign-in',
          avatarQuery: '',
          tab: 'all',
          followedRealms: null,
          children: createElement(WorkAttachment, { work: { ...work, address } }),
        }),
      );
    expect(render()).toContain(`href="/en${encodedWork}"`);
    expect(render({ prefix: '/w/', key: 'renamed-story', suffixSource: 'Other title' })).toContain(
      'href="/en/w/renamed-story"',
    );
  });

  test('every feed fixture emits durable Work links, including action destinations', () => {
    for (const item of everyKind) {
      const actionHref = 'href' in item.primaryAction ? item.primaryAction.href : null;
      for (const href of [item.links.target, item.links.comments, actionHref]) {
        // ast-grep-ignore: web-links-use-address -- Independent canonical expectation verifies the address builders without calling them again.
        if (!href?.startsWith('/w/')) continue;
        expect(href).not.toMatch(/^\/w\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?:[/?#]|$)/i);
      }
    }
  });
});
