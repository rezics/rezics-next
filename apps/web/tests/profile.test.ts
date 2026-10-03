import { uuidToSid } from '@rezics/model/address';
import { beforeAll, describe, expect, test } from 'bun:test';
import { creditedCard, creditLine, shelfCard, worksSummary } from '../features/profile/cards.ts';
import { authorWorks, organizationWorks, storyProfile } from '../features/profile/fixtures.ts';
import { followerLabel } from '../features/profile/followers.ts';
import { messages } from '../features/profile/messages.ts';
import zhHans from '../features/profile/messages/zh-Hans.ts';
import { profileJsonLd, profileMetadata } from '../features/profile/metadata.ts';
import { initials } from '../features/profile/profile-avatar.tsx';
import {
  isNativeHandle,
  parseCursor,
  parseHandleSegment,
  parseShelfStatus,
  profileHref,
} from '../features/profile/route.ts';
import { isPublicPagePath, localizedPath, pathLocale } from '../i18n/locale.ts';
import { seedServedTypes } from '../features/catalogue/type-fixtures.ts';

beforeAll(seedServedTypes);

const zh = { ...messages, ...zhHans };
const uuid = '0192e0aa-4b5a-7c6d-8e7f-9a0b1c2d3e4f';

describe('profile addresses', () => {
  test('a `[handle]` segment names a profile only with `@` and a handle Main can hold', () => {
    expect(parseHandleSegment('@lin_mei')).toBe('lin_mei');
    // Main matches vanity handles without regard to case and redirects to the lower-case one.
    expect(parseHandleSegment('@Lin_Mei')).toBe('Lin_Mei');
    expect(parseHandleSegment('@lin-mei')).toBe('lin-mei');
    expect(parseHandleSegment('@agent-not-a-uuid')).toBe('agent-not-a-uuid');
    expect(parseHandleSegment('%40lin_mei')).toBe('lin_mei');
    expect(parseHandleSegment(`@agent-${uuid}`)).toBe(`agent-${uuid}`);
    for (const segment of [
      'lin_mei',
      'discover',
      '@',
      '@ab',
      `@${'a'.repeat(31)}`,
      '@lin mei',
      '@../w',
      '@@lin_mei',
    ])
      expect(parseHandleSegment(segment)).toBeNull();
  });

  test('views and pages keep the handle and add only a Main cursor', () => {
    expect(profileHref('lin_mei')).toBe('/@lin_mei');
    expect(profileHref('lin_mei', { kind: 'works' })).toBe('/@lin_mei/works');
    expect(profileHref('lin_mei', { kind: 'shelf', status: 'want-to-read' }, 'a b')).toBe(
      '/@lin_mei/shelves/want-to-read?cursor=a+b',
    );
    expect(parseShelfStatus('reading')).toBe('reading');
    expect(parseShelfStatus('to-read')).toBeNull();
    expect(parseCursor(['a', 'b'])).toBeUndefined();
    expect(parseCursor('x'.repeat(2049))).toBeUndefined();
    expect(parseCursor('abc')).toBe('abc');
  });

  test('profiles are public pages: locale-prefixed, redirected from the bare path and linked in the UI locale', () => {
    expect(isPublicPagePath('/@lin_mei')).toBe(true);
    expect(isPublicPagePath('/en/@lin_mei/shelves/read')).toBe(true);
    expect(isPublicPagePath('/%40lin_mei')).toBe(true);
    expect(isPublicPagePath('/@')).toBe(false);
    expect(localizedPath('/@lin_mei', 'zh-Hans')).toBe('/zh-Hans/@lin_mei');
    expect(pathLocale('/ja/@lin_mei')).toBe('ja');
  });
});

describe('profile cards', () => {
  test('a work row credits the profile as Goodreads does: the name for an author, roles in brackets otherwise', () => {
    expect(creditLine('Lin Mei', ['author'], 'en', messages)).toBe('Lin Mei');
    expect(creditLine('Lin Mei', ['translator'], 'en', messages)).toBe('Lin Mei (Translator)');
    expect(creditLine('Lin Mei', ['editor', 'author'], 'en', messages)).toBe(
      'Lin Mei (Author, Editor)',
    );
    expect(creditLine('林梅', ['translator'], 'zh-Hans', zh)).toBe('林梅（译者）');
  });

  test('credited Works become catalogue cards with their cover kind, Global rating, pitch and serial state', () => {
    const [serial, translation, prompt, dumplings] = authorWorks.items;
    const card = creditedCard(serial!, 'Lin Mei 林梅', 'lin_mei', 'en', messages);
    expect(card).toMatchObject({
      id: serial!.id,
      href: `/w/${uuidToSid(serial!.id.slice(-36))}`,
      kind: 'book',
      authors: [{ name: 'Lin Mei 林梅', href: '/@lin_mei' }],
      rating: { mean: 4.4, count: 128, max: 5 },
      completion: 'ongoing',
    });
    expect(card.tagline?.value).toStartWith('一封没有地址的信');
    expect(creditedCard(translation!, 'Lin Mei', 'lin_mei', 'en', messages).authors).toEqual([
      { name: 'Lin Mei (Translator)', href: '/@lin_mei' },
    ]);
    expect(creditedCard(prompt!, 'Lin Mei', 'lin_mei', 'en', messages).kind).toBe('document');
    expect(creditedCard(dumplings!, 'Lin Mei', 'lin_mei', 'en', messages).kind).toBe('recipe');
    // Main's shelf read names a title, cover and types, so a shelf draws the Work's usual cover.
    expect(
      shelfCard({
        id: serial!.id,
        title: serial!.title,
        cover: serial!.cover,
        types: serial!.types,
      }),
    ).toMatchObject({ kind: 'book', authors: [], rating: null });
    expect(
      shelfCard({
        id: prompt!.id,
        title: prompt!.title,
        cover: prompt!.cover,
        types: prompt!.types,
      }).kind,
    ).toBe('document');
  });

  test('the works summary averages every rating only when the whole list is loaded', () => {
    const summary = worksSummary(authorWorks);
    expect(summary).toMatchObject({ works: 5, complete: true, rating: { count: 186, max: 5 } });
    const sum = authorWorks.items.reduce((total, item) => total + (item.rating?.sum ?? 0), 0);
    expect(summary.rating!.mean).toBeCloseTo(sum / 186, 10);
    expect(worksSummary(organizationWorks)).toMatchObject({
      works: 4,
      complete: false,
      rating: null,
    });
    expect(
      worksSummary({
        items: authorWorks.items.map((item) => ({ ...item, rating: null })),
        nextCursor: null,
      }).rating,
    ).toBeNull();
  });
});

describe('profile header', () => {
  test('initials mark a CJK name by its first character and others by two words', () => {
    expect(initials('Lin Mei 林梅')).toBe('LM');
    expect(initials('月下书生 · Moonlit Scribe')).toBe('月');
    expect(initials('North Star Editions · 北辰出版')).toBe('NS');
    expect(initials('김민지')).toBe('김');
    expect(initials('élodie')).toBe('É');
  });

  test('followers read as a count, or as a floor when Main stopped counting', () => {
    expect(followerLabel({ kind: 'exact', value: 1 }, 'en', messages)).toBe('1 follower');
    expect(followerLabel({ kind: 'exact', value: 1204 }, 'en', messages)).toBe('1,204 followers');
    expect(followerLabel({ kind: 'lower-bound', value: 1000 }, 'en', messages)).toBe(
      '1,000+ followers',
    );
    expect(followerLabel({ kind: 'exact', value: 3 }, 'zh-Hans', zh)).toBe('3 位关注者');
  });
});

describe('profile metadata', () => {
  test('titles name the handle; descriptions prefer the bio, then say what the page holds', () => {
    const profile = storyProfile();
    expect(profileMetadata(profile, true, 'en', messages)).toMatchObject({
      title: 'Lin Mei 林梅 (@lin_mei)',
      description: profile.bio!.text,
      openGraph: { type: 'profile', username: 'lin_mei' },
    });
    const quiet = storyProfile({ bio: null });
    expect(profileMetadata(quiet, true, 'en', messages).description).toStartWith(
      'Works by Lin Mei 林梅',
    );
    expect(profileMetadata(quiet, false, 'en', messages).description).toStartWith(
      'What Lin Mei 林梅 is reading',
    );
    expect(
      profileMetadata(
        storyProfile({
          bio: null,
          library: { visibility: 'private', statusShelvesVisible: false },
        }),
        false,
        'en',
        messages,
      ).description,
    ).toBe('Lin Mei 林梅 on REZICS.');
    // An unnamed profile titles only the display name and exposes no username.
    const native = storyProfile({ handle: null });
    expect(isNativeHandle(`agent-${uuid}`)).toBe(true);
    expect(isNativeHandle('lin_mei')).toBe(false);
    expect(profileMetadata(native, true, 'en', messages)).toMatchObject({
      title: 'Lin Mei 林梅',
      openGraph: { type: 'profile' },
    });
    expect(profileMetadata(native, true, 'en', messages).openGraph).not.toHaveProperty('username');
    expect(JSON.parse(profileJsonLd(native, null)).mainEntity).not.toHaveProperty('alternateName');
  });

  test('JSON-LD describes a ProfilePage and cannot close its script element', () => {
    const json = profileJsonLd(
      storyProfile({ displayName: '</script><script>alert(1)</script>' }),
      12,
    );
    expect(json).not.toContain('<');
    expect(JSON.parse(json)).toMatchObject({
      '@type': 'ProfilePage',
      mainEntity: {
        '@type': 'Person',
        name: '</script><script>alert(1)</script>',
        alternateName: '@lin_mei',
        interactionStatistic: { userInteractionCount: 12 },
      },
    });
    expect(
      JSON.parse(profileJsonLd(storyProfile({ kind: 'organization' }), null)).mainEntity,
    ).not.toHaveProperty('interactionStatistic');
  });
});
