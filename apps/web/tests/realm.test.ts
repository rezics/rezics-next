import { uuidToSid } from '@rezics/model/address';
import { beforeAll, describe, expect, test } from 'bun:test';
import {
  bannerImage,
  liveBanners,
  mainExecution,
  zoneDecision,
  zoneImage,
  zonePeople,
  zoneText,
  zoneWork,
} from '../features/realm/adapt.ts';
import { type JoinPolicy, offerOf } from '../features/realm/membership-state.ts';
import { chartMetric, withRealmCard } from '../features/realm/modules.ts';
import {
  decisionAnchor,
  decisionHref,
  idOf,
  parseCursor,
  parseRealmRef,
  realmHref,
  realmWorkHref,
  repeatsTab,
  scopedWorkHref,
  siteHref,
  tabOf,
} from '../features/realm/route.ts';
import type { RealmDecision, WorkCard, ZonePresentationRead } from '../features/realm/types.ts';
import { isPublicPagePath, localizedPath } from '../i18n/locale.ts';
import { seedServedTypes } from '../features/catalogue/type-fixtures.ts';

beforeAll(seedServedTypes);

const realm = '7c3e9a1d-2b4f-4d6e-8a0c-5e7f9b1d3c2a';
const work = '5f7a2c1e-8d3b-4c6a-9e2f-1b4d6a8c0e3f';
const decision = '01a0e3d0-dca8-7737-ac65-b7444eb96b02';
const iri = (id: string) => `https://rezics.com/id/${id}`;

describe('Realm addresses', () => {
  test('a ref is a Realm UUID or an official Zone segment; anything else is no Realm', () => {
    expect(parseRealmRef(realm)).toEqual({ kind: 'id', id: realm });
    expect(parseRealmRef('fiction')).toEqual({ kind: 'segment', segment: 'fiction' });
    expect(parseRealmRef('ai-workshop')).toEqual({ kind: 'segment', segment: 'ai-workshop' });
    expect(parseRealmRef('Fiction')).toEqual({ kind: 'segment', segment: 'Fiction' });
    expect(parseRealmRef(uuidToSid(realm))).toEqual({ kind: 'id', id: realm });
    for (const ref of ['', 'a/b', 'a\\b', 'a?b', 'a#b', 'a\u0000b', 'x'.repeat(513)]) {
      expect(parseRealmRef(ref)).toBeNull();
    }
  });

  test('tabs are separate URLs under the locale, and Home has no tab segment', () => {
    expect(realmHref('en', 'fiction')).toBe('/en/r/fiction');
    expect(realmHref('zh-Hans', realm, 'decisions')).toBe(
      `/zh-Hans/r/${uuidToSid(realm)}/decisions`,
    );
    expect(realmHref('en', 'fiction', 'works', { cursor: 'abc', safe: undefined })).toBe(
      '/en/z/fiction/browse?cursor=abc',
    );
    expect(tabOf('/en/r/fiction')).toBe('home');
    expect(tabOf('/zh-Hans/r/fiction/about')).toBe('about');
    // A page of the Zone's own site is none of the tabs.
    expect(tabOf('/en/r/fiction/guide')).toBeNull();
  });

  test('Realm pages are a localized page family: an unprefixed address gets the reader’s locale', () => {
    expect(isPublicPagePath('/r/fiction')).toBe(true);
    expect(isPublicPagePath('/zh-Hans/r/fiction/works')).toBe(true);
    expect(localizedPath('/r/fiction/about', 'ja')).toBe('/ja/r/fiction/about');
    expect(isPublicPagePath('/reports')).toBe(false);
  });

  test('"Why here?" links open the Decision on the Decisions tab', () => {
    expect(decisionAnchor(iri(decision))).toBe(`decision-${decision}`);
    expect(decisionHref('en', 'fiction', iri(decision))).toBe(
      `/en/r/fiction/decisions?decision=${decision}#decision-${decision}`,
    );
  });

  test('a Work opened from a Zone opens inside the Zone, through its mount when it came from one', () => {
    expect(realmWorkHref('books', iri(work))).toBe(`/z/books/w/${uuidToSid(work)}`);
    expect(realmWorkHref('books', work, 'picks')).toBe(`/z/books/picks/${uuidToSid(work)}`);
    expect(realmWorkHref(realm, iri(work), null, 'discussion')).toBe(
      `/z/${uuidToSid(realm)}/w/${uuidToSid(work)}/discussion`,
    );
    expect(siteHref('zh-Hans', 'books', ['picks'], { cursor: 'c', safe: undefined })).toBe(
      '/zh-Hans/z/books/picks?cursor=c',
    );
    // A Realm with no Zone site keeps the Work's own page in the Realm's scope.
    expect(scopedWorkHref(iri(work), realm)).toBe(
      `/w/${uuidToSid(work)}?scope=realm&realm=${realm}`,
    );
  });

  test('a Zone link that only repeats a Realm tab stays out of the tab row', () => {
    expect(repeatsTab('/r/fiction', 'fiction')).toBe(true);
    expect(repeatsTab('/zh-Hans/r/fiction/about/', 'fiction')).toBe(true);
    expect(repeatsTab('/en/z/fiction/browse?cursor=2', 'fiction')).toBe(false);
    expect(repeatsTab('/r/fiction#zone-module-charts', 'fiction')).toBe(true);
    expect(repeatsTab('/r/books', 'fiction')).toBe(false);
    expect(repeatsTab('/discover?term=1', 'fiction')).toBe(false);
  });

  test('chart metrics use Main’s ranking vocabulary', () => {
    expect(chartMetric('reads')).toBe('reads');
    expect(chartMetric(undefined)).toBe('reads');
    expect(chartMetric('finished-chapters')).toBe('finished-chapters');
  });

  test('cursors come from the URL only when well formed', () => {
    expect(parseCursor({ cursor: 'abc' })).toBe('abc');
    expect(parseCursor({ cursor: ['a', 'b'] })).toBeUndefined();
    expect(parseCursor({ cursor: 'x'.repeat(2049) })).toBeUndefined();
    expect(idOf('https://example.com/id/x')).toBeNull();
  });
});

const name = (value: string, language = 'en') => ({
  value,
  language,
  direction: 'ltr' as const,
  basis: 'requested' as const,
});
const card = (overrides: Partial<WorkCard> = {}): WorkCard => ({
  id: iri(work),
  title: name('The Cartographer of Tides'),
  cover: {
    kind: 'image',
    selection: 's',
    url: '/v1/media/avatars/s',
    mediaType: 'image/webp',
    width: 400,
    height: 600,
    crop: null,
    basis: { policy: 'p', context: 'c' },
  },
  types: ['https://schema.org/Book'],
  tagline: name('A delta that redraws itself.'),
  completionStatus: 'ongoing',
  chapterCount: 41,
  wordCount: null,
  lastUpdatedAt: '2026-09-27T12:00:00.000Z',
  ...overrides,
});
const context = { locale: 'en' as const, ref: 'fiction', realm };

describe('Main reads as Zone data', () => {
  test('a Work card keeps its hook, status and cover, and links its Decision', () => {
    const adapted = zoneWork(card(), context, iri(decision));
    expect(adapted).toEqual({
      id: iri(work),
      href: `/z/fiction/w/${uuidToSid(work)}`,
      title: { value: 'The Cartographer of Tides', lang: 'en', dir: 'ltr' },
      cover: { url: '/api/main/v1/media/avatars/s', width: 400, height: 600 },
      kind: 'book',
      author: null,
      authorHref: null,
      tagline: { value: 'A delta that redraws itself.', lang: 'en', dir: 'ltr' },
      status: 'ongoing',
      chapters: 41,
      words: null,
      updatedAt: '2026-09-27T12:00:00.000Z',
      decision: `/en/r/fiction/decisions?decision=${decision}#decision-${decision}`,
      hub: null,
    });
    expect(zoneWork(card({ tagline: null }), context, null)).toMatchObject({
      tagline: null,
      decision: null,
    });
  });

  test('a Zone card keeps a credited author’s REZICS destination through a thinner module card', () => {
    const credited = zoneWork(
      {
        ...card(),
        primaryCredits: [
          {
            agent: null,
            handle: null,
            displayName: 'Jane Austen',
            provider: 'open-library',
            key: '/authors/OL21594A',
          },
        ],
      },
      context,
      null,
    );
    expect(credited.authorHref).toBe('/authors/open-library/OL21594A');
    const thin = zoneWork(card(), context, null);
    expect(withRealmCard(thin, credited)).toMatchObject({
      author: credited.author,
      authorHref: '/authors/open-library/OL21594A',
    });
  });

  test('a thinner card keeps the Realm card’s Hub item and does not carry a mod bag', () => {
    const hub = {
      profile: 'hub-work-card-v1' as const,
      kind: 'prompt' as const,
      declaredModels: [],
      testedModels: ['model-a'],
      preview: 'Opening',
      copyText: 'Full text',
    };
    const adapted = zoneWork({ ...card(), hub }, context, null);
    expect(adapted.hub).toMatchObject({ kind: 'prompt', copyText: 'Full text' });
    expect(adapted).not.toHaveProperty('mod');
    expect(withRealmCard(zoneWork(card(), context, null), adapted).hub).toEqual(adapted.hub);
  });

  test('a people module names each credited author once, with their Works here, and links where to find more', () => {
    const name = (value: string, language = 'en') => ({
      value,
      language,
      direction: 'ltr' as const,
      basis: 'requested' as const,
    });
    const austen = {
      agent: null,
      handle: null,
      displayName: 'Jane Austen',
      provider: 'open-library',
      key: 'OL21594A',
    };
    const maren = {
      agent: iri('00000000-0000-4000-8000-0000000000aa'),
      handle: 'maren',
      displayName: 'Maren Osei',
      provider: null,
      key: null,
    };
    const people = zonePeople(
      [
        { title: name('Pride and Prejudice'), primaryCredits: [austen] },
        {
          title: name('The Cartographer of Tides'),
          primaryCredits: [maren, { ...austen, displayName: null }],
        },
        { title: name('Emma'), primaryCredits: [austen] },
        { title: name('Persuasion'), primaryCredits: [austen] },
      ],
      6,
    );
    expect(people).toEqual([
      {
        id: 'open-library:OL21594A',
        name: { value: 'Jane Austen', lang: '', dir: 'ltr' },
        avatar: null,
        href: '/authors/open-library/OL21594A',
        note: { value: 'Pride and Prejudice · Emma · Persuasion', lang: 'en', dir: 'ltr' },
      },
      {
        id: maren.agent,
        name: { value: 'Maren Osei', lang: '', dir: 'ltr' },
        avatar: null,
        href: '/@maren',
        note: { value: 'The Cartographer of Tides', lang: 'en', dir: 'ltr' },
      },
    ]);
    // A limit keeps the first authors; a note in two languages declares none.
    expect(
      zonePeople(
        [
          { title: name('Emma'), primaryCredits: [austen] },
          { title: name('西游记', 'zh-Hans'), primaryCredits: [austen] },
        ],
        1,
      )[0]!.note,
    ).toEqual({ value: 'Emma · 西游记', lang: '', dir: 'ltr' });
    expect(
      zonePeople(
        [
          { title: name('Emma'), primaryCredits: [austen] },
          { title: name('Tides'), primaryCredits: [maren] },
        ],
        1,
      ),
    ).toHaveLength(1);
  });

  test('a generated fallback cover is no image, so the cover seam sets the title instead', () => {
    expect(zoneImage({ kind: 'fallback', policy: 'p', key: 'k', resourceType: 'work' })).toBeNull();
    expect(zoneImage(null)).toBeNull();
    expect(zoneText(null)).toBeNull();
  });

  test('a signed-in reader’s images name the Agent they read as, as the catalogue’s covers do', () => {
    expect(zoneImage(card().cover, '?actingSubject=x')?.url).toBe(
      '/api/main/v1/media/avatars/s?actingSubject=x',
    );
    expect(
      zoneWork(
        card({ types: ['https://schema.org/Recipe'] }),
        { ...context, avatarQuery: '?actingSubject=x' },
        null,
      ),
    ).toMatchObject({
      kind: 'recipe',
      cover: { url: '/api/main/v1/media/avatars/s?actingSubject=x' },
    });
  });

  test('a Decision is titled from Works the page already read, and never guesses', () => {
    const titled = new Map([[iri(work), zoneWork(card(), context, null)]]);
    const item = (overrides: Partial<RealmDecision>): RealmDecision => ({
      id: iri(decision),
      kind: 'adoption',
      dataEpoch: '1',
      sequence: '9',
      work: iri(work),
      subject: iri(work),
      outcome: null,
      ...overrides,
    });
    expect(zoneDecision(item({}), context, titled)).toEqual({
      id: iri(decision),
      kind: 'adoption',
      outcome: null,
      sequence: '9',
      href: `/en/r/fiction/decisions?decision=${decision}#decision-${decision}`,
      work: {
        id: iri(work),
        href: `/z/fiction/w/${uuidToSid(work)}`,
        title: { value: 'The Cartographer of Tides', lang: 'en', dir: 'ltr' },
      },
    });
    expect(zoneDecision(item({ work: iri(realm) }), context, titled).work).toBeNull();
  });

  test('Main’s execution report carries the approved source digest and fallback reason', () => {
    const read = (
      reason: Extract<ZonePresentationRead['execution'], { state: 'fallback' }>['reason'],
    ) => ({ execution: { state: 'fallback', reason } }) as ZonePresentationRead;
    expect(mainExecution(read('none_approved'))).toEqual({
      approved: null,
      reason: 'none-approved',
    });
    expect(mainExecution(read('safe_mode'))).toEqual({ approved: null, reason: 'safe-mode' });
    expect(mainExecution(read('viewer_opt_out'))).toEqual({
      approved: null,
      reason: 'viewer-opt-out',
    });
    const approved = {
      execution: { state: 'package', packageDigest: `sha256:${'a'.repeat(64)}` },
    } as unknown as ZonePresentationRead;
    expect(mainExecution(approved)).toEqual({
      approved: { digest: `sha256:${'a'.repeat(64)}` },
      reason: 'none-approved',
    });
  });

  test('banners show inside their schedule, their media through the BFF', () => {
    const banner = (id: string, startsAt?: string, endsAt?: string) => ({
      id,
      title: id,
      alt: '',
      href: '/en/r/x',
      image: iri(work),
      ...(startsAt ? { startsAt } : {}),
      ...(endsAt ? { endsAt } : {}),
    });
    const now = Date.parse('2026-09-28T00:00:00.000Z');
    expect(
      liveBanners(
        [
          banner('always'),
          banner('past', undefined, '2026-09-01T00:00:00.000Z'),
          banner('future', '2026-10-01T00:00:00.000Z'),
          banner('now', '2026-09-27T00:00:00.000Z', '2026-09-29T00:00:00.000Z'),
        ],
        now,
      ).map((item) => item.id),
    ).toEqual(['always', 'now']);
    expect(
      bannerImage(banner('b'), [
        {
          id: 'b',
          image: {
            url: `/v1/media/uses/${work}`,
            width: 1440,
            height: 540,
            mediaType: 'image/webp',
          },
        },
      ]),
    ).toEqual({ url: `/api/main/v1/media/uses/${work}`, width: 1440, height: 540 });
  });
});

describe('Joining and following a Realm', () => {
  const policy: JoinPolicy = {
    policyRevision: '1',
    termsRevision: 't',
    selfJoin: true,
    open: true,
    membershipGeneration: '0',
    state: 'absent',
  };
  test('a member has joined; an open Realm asks to Join; any other Realm can be followed', () => {
    const offer = (overrides: Partial<JoinPolicy> | null) =>
      offerOf({
        following: false,
        followRevision: null,
        policy: overrides && { ...policy, ...overrides },
      });
    expect(offer({ state: 'joined' })).toBe('joined');
    expect(offer({ state: 'joined', open: false })).toBe('joined');
    expect(offer({})).toBe('join');
    expect(offer({ state: 'left' })).toBe('join');
    expect(offer({ selfJoin: false })).toBe('follow');
    expect(offer({ open: false })).toBe('follow');
    expect(offer(null)).toBe('follow');
  });
});

describe('Cards across a Zone', () => {
  test('a thin module card takes the author, hook, kind and Decision from the Realm’s card', () => {
    const thin = zoneWork(
      card({ tagline: null, types: [], completionStatus: null }),
      context,
      null,
    );
    const known = {
      ...zoneWork(card({ types: ['https://schema.org/DigitalDocument'] }), context, iri(decision)),
      author: { value: '北岛听风', lang: '', dir: 'ltr' as const },
    };
    expect(withRealmCard(thin, known)).toMatchObject({
      kind: 'document',
      author: { value: '北岛听风' },
      tagline: { value: 'A delta that redraws itself.' },
      status: 'ongoing',
      decision: `/en/r/fiction/decisions?decision=${decision}#decision-${decision}`,
    });
    expect(withRealmCard(thin, undefined)).toBe(thin);
    // What the module read already says wins.
    const own = { ...thin, tagline: { value: 'Its own hook', lang: 'en', dir: 'ltr' as const } };
    expect(withRealmCard(own, known).tagline?.value).toBe('Its own hook');
  });
});
