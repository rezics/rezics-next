import { describe, expect, test } from 'bun:test';
import { canonicalHref, resourceHref, targetKey } from '../features/address/path.ts';
import { signInDestinationMatches } from './account-sign-in.ts';

const work = '01944100-0000-7000-8000-000000000100';
const otherWork = '01944100-0000-7000-8000-000000000101';
const workPath = resourceHref('/w/', work);
const otherWorkPath = resourceHref('/w/', otherWork);
const aliasPath = resourceHref('/w/', 'named-alias');
const otherAliasPath = resourceHref('/w/', 'named-alias-extra');
const at = (path: string) => new URL(path, 'https://web.rezics.test');
// ast-grep-ignore: web-links-use-address -- These are address-owner prefix fixtures; canonicalHref builds every native URL.
const canonicalPrefixes = ['/w/', '/e/', '/a/', '/z/', '/r/', '/concepts/'] as const;

describe('sign-in destination matching', () => {
  for (const prefix of canonicalPrefixes) {
    for (const locale of ['en', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'de', 'fr', 'es'] as const) {
      for (const tail of [
        '',
        '/connections',
        '/editions',
        '/contents',
        '/versions',
        '/discussion',
        '/history',
        '/contents/chapter-one/notes',
      ]) {
        test(`accepts canonical ${prefix} titles before ${locale} ${tail || 'overview'}`, () => {
          const path = canonicalHref({ prefix, key: targetKey(work), suffixSource: '' }, locale);
          for (const [actualSuffix, expectedSuffix] of [
            ['', ''],
            ['-new-title', ''],
            ['', '-old-title'],
            ['-new-title', '-old-title'],
          ])
            expect(
              signInDestinationMatches(
                at(`${path}${actualSuffix}${tail}`),
                `${path}${expectedSuffix}${tail}?after=page-2#parts`,
              ),
            ).toBe(true);
        });
      }
    }
  }

  test('recognizes the same native Work identity across its UUID and canonical short key', () => {
    expect(
      signInDestinationMatches(
        at(`/en${workPath}-new-testament/connections`),
        // ast-grep-ignore: web-links-use-address -- The historical UUID address has no current link builder.
        `/en/w/${work}/connections`,
      ),
    ).toBe(true);
    expect(
      signInDestinationMatches(
        at(`/en${workPath}-new-title/connections`),
        `/en${workPath}-old-title/connections`,
      ),
    ).toBe(true);
  });

  test('retains locale, resource identity, route and the complete tail', () => {
    const next = `/en${workPath}/connections`;
    for (const path of [
      `/ja${workPath}-new-testament/connections`,
      `${workPath}-new-testament/connections`,
      `/en${otherWorkPath}-new-testament/connections`,
      `/en${workPath}-new-testament/editions`,
      `/en${workPath}-new-testament/connections/extra`,
      `/en${workPath}/connections-extra`,
      `/en${workPath}/connections-extra/child`,
      `/en${workPath}/connections/extra`,
      `/en${workPath}-new-testament`,
      `/en${workPath}/connections/`,
    ])
      expect(signInDestinationMatches(at(path), next)).toBe(false);
    expect(
      signInDestinationMatches(
        at(`/en${workPath}-title/contents/chapter-two/notes`),
        `/en${workPath}/contents/chapter-one/notes`,
      ),
    ).toBe(false);
  });

  test('preserves the address owner prefix when the identity is the same', () => {
    for (const prefix of canonicalPrefixes)
      for (const otherPrefix of canonicalPrefixes) {
        if (prefix === otherPrefix) continue;
        expect(
          signInDestinationMatches(
            at(canonicalHref({ prefix, key: targetKey(work), suffixSource: 'Title' }, 'en')),
            canonicalHref({ prefix: otherPrefix, key: targetKey(work), suffixSource: '' }, 'en'),
          ),
        ).toBe(false);
      }
  });

  test('preserves locale, identity and the complete route tail for every canonical prefix', () => {
    for (const prefix of canonicalPrefixes) {
      const path = canonicalHref({ prefix, key: targetKey(work), suffixSource: '' }, 'en');
      const other = canonicalHref({ prefix, key: targetKey(otherWork), suffixSource: '' }, 'en');
      const next = `${path}/connections`;
      for (const actual of [
        path.replace('/en/', '/ja/') + '-title/connections',
        `${other}-title/connections`,
        `${path}-title/editions`,
        `${path}-title/connections/extra`,
        `${path}-title/connections-extra`,
        `${path}-title/connections/`,
        `${path}-title`,
        `${path}%ZZ/connections`,
        `${path}%2Ftitle/connections`,
      ])
        expect(signInDestinationMatches(at(actual), next)).toBe(false);
      expect(
        signInDestinationMatches(
          at(`${path}-title/contents/chapter-two/notes`),
          `${path}/contents/chapter-one/notes`,
        ),
      ).toBe(false);
    }
  });

  test('does not treat similarly prefixed routes or aliases as canonical identities', () => {
    for (const [path, next] of [
      ['/en/manage-extra', '/en/manage'],
      ['/en/studio-extra', '/en/studio'],
      [`/en${otherAliasPath}/connections`, `/en${aliasPath}/connections`],
      [`/en${otherAliasPath}`, `/en${aliasPath}`],
    ])
      expect(signInDestinationMatches(at(path!), next!)).toBe(false);
    expect(signInDestinationMatches(at('/en/manage'), '/en/manage?sort=recent#queue')).toBe(true);
    expect(
      signInDestinationMatches(
        at(`/en${aliasPath}/connections`),
        `/en${aliasPath}/connections`,
      ),
    ).toBe(true);
    for (const prefix of canonicalPrefixes) {
      const alias = canonicalHref({ prefix, key: 'named-alias', suffixSource: '' }, 'en');
      expect(
        signInDestinationMatches(at(`${alias}-extra/connections`), `${alias}/connections`),
      ).toBe(false);
      expect(signInDestinationMatches(at(`${alias}/connections`), `${alias}/connections`)).toBe(true);
    }
  });

  test('only accepts the onboarding destination when the journey opted in', () => {
    expect(signInDestinationMatches(at('/en/onboarding'), '/en/manage')).toBe(false);
    expect(signInDestinationMatches(at('/en/onboarding'), '/en/manage', true)).toBe(true);
    expect(signInDestinationMatches(at('/en/onboarding-extra'), '/en/manage', true)).toBe(false);
  });
});
