import { describe, expect, test } from 'bun:test';
import { checkZonePresentation } from '../../../services/main/src/modules/zone/presentation-format.ts';
import { checkFirstPartyBundle } from '../../../services/main/src/modules/theme/first-party-bundle.ts';
import { uiLocales } from '../../../apps/web/i18n/define.ts';
import { editorList, extraWorks, fictionQuotes, fictionWorks, officialPresentation, type OfficialRealmId, penNames,
  officialTheme, packagedZone, publicTexts, realmProfiles, zoneContent } from './official-plan.ts';
import { officialBuildBundle, officialSourceDigest, themeNeedsActivation, themeNeedsRevision }
  from './official-theme-step.ts';
import { people, penNames as basePenNames, realms, works } from './plan.ts';

const official = Object.keys(zoneContent) as OfficialRealmId[];
const known = new Set([...works.map(work => work.id), ...fictionWorks.map(work => work.id),
  ...extraWorks.map(work => work.id)]);

describe('Official Zone presentations', () => {
  test('every official Realm has a layout Main accepts, under its own preset', () => {
    expect(official.sort()).toEqual(realms.map(realm => realm.id).sort());
    for (const realm of realms) {
      const presentation = officialPresentation(realm.id, realm.preset);
      expect(checkZonePresentation(presentation, [])).toBe(presentation);
      expect(presentation.navigation).toEqual([]);
      expect(presentation.modules.map(module => module.type)).toContain('hero-carousel');
      // Every module and tab speaks the Zone's languages.
      for (const module of presentation.modules) {
        const titles = module.titles;
        expect(titles).toMatchObject({ en: module.title });
        if (!titles) throw new Error('Official modules should have localized titles.');
        for (const locale of uiLocales) {
          const title = titles[locale];
          if (typeof title !== 'string') throw new Error(`Official modules need a ${locale} title.`);
          expect(title.trim()).not.toBe('');
        }
        for (const tab of module.type === 'shelf' ? module.tabs ?? [] : []) {
          expect(tab.labels).toMatchObject({ en: tab.label });
          for (const locale of uiLocales) expect(tab.labels?.[locale]?.trim()).not.toBe('');
        }
      }
    }
  });

  test('Fiction reads as a serial publication', () => {
    const fiction = officialPresentation('fiction', 'serial');
    expect(fiction.modules.map(module => module.type)).toEqual(['hero-carousel', 'announcement', 'shelf', 'ranking',
      'editorial-list', 'quote-stream', 'rising', 'decision-log']);
    const editors = fiction.modules.find(module => module.type === 'editorial-list')!;
    expect([editors.source, ...editors.tabs!.map(tab => tab.source)]).toEqual(zoneContent.fiction.lists
      .map(list => ({ kind: 'collection', collection: editorList('fiction', list.id) })));
  });

  test('package placements point at stable theme IDs and the data sources their slots need', () => {
    for (const realm of official) {
      const layout = officialPresentation(realm, realms.find(item => item.id === realm)!.preset);
      expect(layout.official?.theme ?? null).toBe(packagedZone(realm) ? officialTheme(realm) : null);
    }
    const mods = officialPresentation('mods', 'vibrant',
      'https://rezics.com/id/00000000-0000-0000-0000-000000000001').modules;
    expect(mods.map(module => module.id)).toContain('games');
    expect(mods.find(module => module.id === 'games')?.type).toBe('chip-nav');
    expect(mods.find(module => module.id === 'trending')).toMatchObject({ type: 'ranking',
      options: { metric: 'reads', interval: 'week' } });
    expect(officialPresentation('books', 'editorial').modules.find(module => module.id === 'authors')?.type)
      .toBe('people');
    expect(zoneContent['ai-workshop'].lists.map(list => list.id))
      .toEqual(['reading-prompts', 'writing-prompts']);
  });
});

describe('Official package approval plan', () => {
  test('manifest records built bytes and only the package slots', async () => {
    const digest = await officialSourceDigest('mods');
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    const bundle = await officialBuildBundle('mods', digest, officialTheme('mods'), {
      entry: { src: 'zones/official/mods/index.tsx', file: '_next/static/mods.js' },
      style: { src: 'zones/official/mods/mods.css?raw', file: '_next/static/mods-css.js' },
      unrelated: { src: 'zones/official/books/index.tsx', file: '_next/static/books.js' },
    }, async path => new TextEncoder().encode(path));
    expect(checkFirstPartyBundle(bundle).bundle).toEqual({ ...bundle,
      files: [...bundle.files].sort((a, b) => a.path.localeCompare(b.path)),
      slots: [...bundle.slots].sort() });
    expect(bundle.files).toHaveLength(2);
  });

  test('changed bytes require a new review; expiry and revocation require a new activation', () => {
    const now = Date.parse('2026-09-28T00:00:00.000Z');
    const view = { revision: officialTheme('mods'), bundle: { packageDigest: 'sha256:old' },
      activation: officialTheme('fiction'), activationRevision: officialTheme('mods'),
      approvalExpiresAt: '2026-12-01T00:00:00.000Z', decision: 'approved' as const,
      revoked: false, globallyDisabled: false };
    expect(themeNeedsRevision(view, 'sha256:new')).toBe(true);
    expect(themeNeedsRevision(view, 'sha256:old')).toBe(false);
    expect(themeNeedsActivation(view, now)).toBe(false);
    expect(themeNeedsActivation({ ...view, revoked: true }, now)).toBe(true);
    expect(themeNeedsActivation({ ...view, approvalExpiresAt: '2026-09-30T00:00:00.000Z' }, now)).toBe(true);
    expect(themeNeedsActivation({ ...view, activationRevision: officialTheme('books') }, now)).toBe(true);
  });
});

describe('Official Zone content', () => {
  test('every adopted or listed Work is one the seed publishes', () => {
    for (const realm of official) {
      const { adopt, lists } = zoneContent[realm];
      expect(new Set(adopt).size).toBe(adopt.length);
      for (const id of [...adopt, ...lists.flatMap(list => list.works)]) expect(known).toContain(id);
      for (const id of lists.flatMap(list => list.works)) expect(adopt).toContain(id);
    }
    for (const id of Object.keys(publicTexts)) expect(works.find(work => work.id === id)?.excerpt).toBeUndefined();
  });

  test('every serial has an author, a hook, chapters and a place in the Fiction Zone', () => {
    const authors = new Set([...penNames.map(pen => pen.id), ...basePenNames.map(pen => pen.id),
      ...people.map(person => person.id)]);
    for (const work of fictionWorks) {
      expect(authors).toContain(work.author);
      expect(work.tagline.length).toBeGreaterThan(8);
      expect(work.chapters.length).toBeGreaterThan(0);
      expect(new Set(work.chapters.map(chapter => chapter.title)).size).toBe(work.chapters.length);
      expect(zoneContent.fiction.adopt).toContain(work.id);
    }
    // Main's new-adoptions page is 20 Works; the Zone's cards read authors from it.
    expect(zoneContent.fiction.adopt.length).toBeLessThanOrEqual(20);
    // Serials and the base plan's Works share one namespace: one id, one Work.
    for (const work of fictionWorks) expect(works.map(item => item.id)).not.toContain(work.id);
  });

  test('pen names have valid, distinct handles and belong to demo people', () => {
    const handles = [...penNames.map(pen => pen.handle), ...people.map(person => person.handle)];
    expect(new Set(handles).size).toBe(handles.length);
    for (const pen of penNames) {
      expect(pen.handle).toMatch(/^[A-Za-z0-9_]{3,30}$/);
      expect(people.map(person => person.id)).toContain(pen.owner);
    }
  });

  test('quotes are long enough for Main to quote, on serials the seed publishes', () => {
    for (const quote of fictionQuotes) {
      expect(quote.body.length).toBeGreaterThanOrEqual(24);
      expect(fictionWorks.map(work => work.id)).toContain(quote.work);
      expect(people.map(person => person.id)).toContain(quote.reader);
    }
  });

  test('each official Realm names its moderators among the demo people', () => {
    for (const realm of official) {
      const profile = realmProfiles[realm];
      expect(profile.moderators.length).toBeGreaterThan(0);
      for (const person of profile.moderators) expect(people.map(item => item.id)).toContain(person);
      expect(profile.rules.length).toBeGreaterThan(0);
    }
  });
});
