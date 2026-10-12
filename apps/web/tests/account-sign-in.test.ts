import { describe, expect, test } from 'bun:test';
import { resourceHref } from '../features/address/path.ts';
import { signInDestinationMatches } from './account-sign-in.ts';

const work = '01944100-0000-7000-8000-000000000100';
const otherWork = '01944100-0000-7000-8000-000000000101';
const workPath = resourceHref('/w/', work);
const otherWorkPath = resourceHref('/w/', otherWork);
const aliasPath = resourceHref('/w/', 'named-alias');
const otherAliasPath = resourceHref('/w/', 'named-alias-extra');
const at = (path: string) => new URL(path, 'https://web.rezics.test');

describe('sign-in destination matching', () => {
  for (const locale of ['en', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'de', 'fr', 'es']) {
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
      test(`accepts a canonical Work title before ${locale} ${tail || 'overview'}`, () => {
        const next = `/${locale}${workPath}${tail}?after=page-2#parts`;
        expect(
          signInDestinationMatches(at(`/${locale}${workPath}-new-testament${tail}`), next),
        ).toBe(true);
        expect(signInDestinationMatches(at(`/${locale}${workPath}${tail}`), next)).toBe(true);
      });
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

  test('does not treat similarly prefixed non-Work routes or aliases as canonical identities', () => {
    for (const [path, next] of [
      ['/en/manage-extra', '/en/manage'],
      ['/en/studio-extra', '/en/studio'],
      [`/en${otherAliasPath}/connections`, `/en${aliasPath}/connections`],
      [`/en${otherAliasPath}`, `/en${aliasPath}`],
      [`/en${resourceHref('/e/', work)}-title`, `/en${resourceHref('/e/', work)}`],
    ])
      expect(signInDestinationMatches(at(path!), next!)).toBe(false);
    expect(signInDestinationMatches(at('/en/manage'), '/en/manage?sort=recent#queue')).toBe(true);
    expect(
      signInDestinationMatches(
        at(`/en${aliasPath}/connections`),
        `/en${aliasPath}/connections`,
      ),
    ).toBe(true);
  });

  test('only accepts the onboarding destination when the journey opted in', () => {
    expect(signInDestinationMatches(at('/en/onboarding'), '/en/manage')).toBe(false);
    expect(signInDestinationMatches(at('/en/onboarding'), '/en/manage', true)).toBe(true);
    expect(signInDestinationMatches(at('/en/onboarding-extra'), '/en/manage', true)).toBe(false);
  });
});
