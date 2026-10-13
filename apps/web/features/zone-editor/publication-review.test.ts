import { fromPlainText } from '@rezics/document';
import { describe, expect, test } from 'vitest';
import {
  browserZoneAuthoring, browserZoneTheme,
  type NavigationSnapshot, type WriteResult, type ZoneThemeSnapshot,
} from './api.ts';
import { readSavedPublicationSelection } from './publication-review.ts';
import { initialThemeState, type ZonePresentationBaseline } from './theme.ts';
import { defaultPresentation, presetTokens } from '../zones/presentation.ts';
import { messages as zoneMessages } from '../zones/messages.ts';
import { zoneContentText } from '../language/untagged.ts';

const zoneId = '00000000-0000-4000-8000-000000000601';
const homeDocument = 'https://rezics.com/id/00000000-0000-4000-8000-000000000699';
const actor = 'https://rezics.com/id/00000000-0000-4000-8000-000000000602';
const zoneHead = 'https://rezics.com/id/00000000-0000-4000-8000-000000000603';
const navigationRevision = 'https://rezics.com/id/00000000-0000-4000-8000-000000000604';
const navigationId = 'https://rezics.com/id/00000000-0000-4000-8000-000000000605';
const changedHead = 'https://rezics.com/id/00000000-0000-4000-8000-000000000606';

// Deliberately differs from the web's clean preset: the authorized producer decides effective defaults.
const ownerPresentation: ZonePresentationBaseline = {
  profile: 'zone-presentation-v2', preset: 'clean',
  tokens: { ...presetTokens.clean, density: 'compact', pageSurface: 'cards' },
  navigation: [{ label: 'Saved archive', href: '/archive' }], modules: [], slides: [],
};
const shellPresentation = defaultPresentation(zoneMessages);

const snapshot: NavigationSnapshot = {
  head: navigationRevision, navigation: navigationId, zoneHead, links: [], complete: true, after: null,
};

type SelectionClients = Parameters<typeof readSavedPublicationSelection>[2];
type Answer = { data: unknown; error: { status: number; value: unknown } | null };

function clients(configuration: WriteResult<ZoneThemeSnapshot>, navigation: WriteResult<NavigationSnapshot> = {
  ok: true, data: snapshot,
}): SelectionClients {
  return {
    authoring: { async readHeads() { return { ok: true, data: { zoneHead, navigationRevision } }; } },
    navigation: {
      async readNavigation() { return navigation; },
      async continueNavigation() { return { ok: false, failure: 'unavailable' }; },
    },
    theme: { async readConfiguration() { return configuration; } },
  };
}

function fakeMain(configuration: unknown = {}, editor: Answer = { data: {
  revision: zoneHead, preview: { presentation: ownerPresentation, navigation: { revision: navigationRevision } },
}, error: null }) {
  const calls: Array<{ operation: string; id: string; query: unknown }> = [];
  const main = { v1: { zones: ({ id }: { id: string }) => ({
    get: async ({ query }: { query: unknown }) => {
      calls.push({ operation: 'heads', id, query });
      return { data: { revision: navigationRevision, ownerRevision: zoneHead }, error: null };
    },
    configuration: { get: async ({ query }: { query: unknown }) => {
      calls.push({ operation: 'configuration', id, query });
      return { data: { revision: zoneHead, configuration: { homeDocument, ...(configuration as object) } }, error: null };
    } },
    'showcase-editor': { get: async ({ query }: { query: unknown }) => {
      calls.push({ operation: 'showcase-editor', id, query });
      return editor;
    } },
  }) } };
  return { calls, main: main as never };
}

describe('saved publication presentation', () => {
  test.each([{}, { presentation: null }])('reads absent presentation semantics from Main without installing a baseline (%j)', async configuration => {
    const fake = fakeMain(configuration);
    const theme = browserZoneTheme(fake.main);
    const result = await readSavedPublicationSelection(zoneId, actor, {
      ...clients({ ok: false, failure: 'unavailable' }), theme,
    });

    expect(result).toEqual({ ok: true, data: {
      homeDocument, zoneHead, navigationRevision, navigationId, navigation: [],
      presentationNavigation: ownerPresentation.navigation,
      theme: { density: 'compact', pageSurface: 'cards' },
    } });
    expect(fake.calls).toEqual([
      { operation: 'configuration', id: zoneId, query: { actingSubject: actor } },
      { operation: 'showcase-editor', id: zoneId, query: { actingSubject: actor } },
    ]);
  });

  test('theme initialization uses the shell default instead of Content-owned Showcase fields', async () => {
    const contentOwnedPresentation: ZonePresentationBaseline = {
      ...ownerPresentation,
      tokens: { ...ownerPresentation.tokens, titleEffect: 'outline' },
      modules: [{ id: 'home-showcase', type: 'hero-carousel', title: 'Home-owned Showcase',
        source: { kind: 'query-block', block: 'new-adoptions' } }],
      slides: [{ id: 'home-showcase-slide', title: 'Home-owned banner', href: '/home-showcase' }],
    };
    const fake = fakeMain({}, { data: { revision: zoneHead,
      preview: { presentation: contentOwnedPresentation, navigation: { revision: navigationRevision } } }, error: null });
    const result = await browserZoneTheme(fake.main, shellPresentation).readConfiguration(zoneId, actor);
    expect(result).toEqual({ ok: true, data: { revision: zoneHead, configuration: { homeDocument },
      effectivePresentation: { revision: zoneHead, presentation: shellPresentation } } });
    expect(fake.calls.map(call => call.operation)).toEqual(['configuration']);

    if (!result.ok) throw new Error('shell default should initialize an absent presentation');
    const initial = initialThemeState(result.data.configuration, result.data.revision, result.data.effectivePresentation);
    expect(initial.kind).toBe('ready');
    if (initial.kind !== 'ready') throw new Error('shell default should be editable');
    expect(initial.state.presentation).toEqual(shellPresentation);
    expect(JSON.stringify(initial.state.presentation)).not.toContain('Home-owned');
  });

  test('uses the saved presentation without requesting effective defaults', async () => {
    const fake = fakeMain({ presentation: ownerPresentation });
    const configuration = await browserZoneTheme(fake.main).readConfiguration(zoneId, actor);
    expect(configuration).toEqual({ ok: true, data: { revision: zoneHead, configuration: { homeDocument, presentation: ownerPresentation } } });
    expect(fake.calls.map(call => call.operation)).toEqual(['configuration']);
    const result = await readSavedPublicationSelection(zoneId, actor, clients(configuration));
    expect(result).toMatchObject({ ok: true, data: { presentationNavigation: ownerPresentation.navigation,
      theme: { density: 'compact', pageSurface: 'cards' } } });
  });

  test.each(['https://rezics.com/id/legacy', { profile: 'zone-presentation-v1' }, { profile: 'unknown' }])(
    'does not replace a legacy or invalid saved presentation (%j)', async presentation => {
      const fake = fakeMain({ presentation });
      const configuration = await browserZoneTheme(fake.main).readConfiguration(zoneId, actor);
      const result = await readSavedPublicationSelection(zoneId, actor, clients(configuration));
      expect(result).toEqual({ ok: false, failure: 'unavailable' });
      expect(fake.calls.map(call => call.operation)).toEqual(['configuration']);
    },
  );

  test('rejects effective defaults read from a different configuration revision', async () => {
    const fake = fakeMain({}, { data: { revision: changedHead, preview: { presentation: ownerPresentation } }, error: null });
    const result = await browserZoneTheme(fake.main).readConfiguration(zoneId, actor);
    expect(result).toEqual({ ok: false, failure: 'stale', currentHead: changedHead });
  });

  test('publication review also checks the effective presentation revision', async () => {
    const result = await readSavedPublicationSelection(zoneId, actor, clients({ ok: true, data: {
      revision: zoneHead, configuration: { homeDocument }, effectivePresentation: { revision: changedHead, presentation: ownerPresentation },
    } }));
    expect(result).toEqual({ ok: false, failure: 'stale', currentHead: zoneHead });
  });

  test.each([undefined, null, 'missing', 'https://rezics.com/id/------------------------------------'])(
    'publication review refuses an absent or invalid prepared home identity (%j)', async homeDocument => {
      expect(await readSavedPublicationSelection(zoneId, actor, clients({ ok: true, data: {
        revision: zoneHead, configuration: { homeDocument, presentation: ownerPresentation },
      } }))).toEqual({ ok: false, failure: 'unavailable' });
    },
  );

  test('publication review includes every continued saved mount', async () => {
    const first = { id: 'first', occurrence: 'first', target: zoneHead,
      name: 'First shelf', segment: 'first', disclosure: 'public' as const };
    const last = { ...first, id: 'last', occurrence: 'last', name: 'Last shelf', segment: 'last' };
    const calls: unknown[] = [];
    const selection = clients({ ok: true, data: { revision: zoneHead, configuration: { homeDocument, presentation: ownerPresentation } } });
    selection.navigation = {
      async readNavigation() { return { ok: true, data: { ...snapshot, links: [first], complete: false, after: 'saved-tail' } }; },
      async continueNavigation(zone, actingSubject, resume) {
        calls.push({ zone, actingSubject, resume });
        return { ok: true, data: { ...snapshot, links: [last] } };
      },
    };
    expect(await readSavedPublicationSelection(zoneId, actor, selection))
      .toMatchObject({ ok: true, data: { navigation: [first, last] } });
    expect(calls).toEqual([{ zone: zoneId, actingSubject: actor, resume: { head: navigationRevision, after: 'saved-tail' } }]);
  });

  test.each([
    { data: null, error: { status: 403, value: {} }, failure: 'denied' },
    { data: null, error: { status: 404, value: {} }, failure: 'denied' },
    { data: null, error: { status: 401, value: {} }, failure: 'sign-in' },
    { data: { revision: zoneHead, preview: {} }, error: null, failure: 'unavailable' },
  ])('preserves the authorized default read failure ($failure)', async ({ data, error, failure }) => {
    const fake = fakeMain({}, { data, error });
    const result = await readSavedPublicationSelection(zoneId, actor, {
      ...clients({ ok: false, failure: 'unavailable' }), theme: browserZoneTheme(fake.main),
    });
    expect(result).toEqual({ ok: false, failure });
  });

  test('refuses an absent presentation when no authorized effective value is available', async () => {
    expect(await readSavedPublicationSelection(zoneId, actor, clients({ ok: true, data: {
      revision: zoneHead, configuration: { homeDocument },
    } }))).toEqual({ ok: false, failure: 'unavailable' });
  });

  test.each([
    { revision: changedHead, navigation: snapshot },
    { revision: zoneHead, navigation: { ...snapshot, head: changedHead } },
    { revision: zoneHead, navigation: { ...snapshot, zoneHead: changedHead } },
    { revision: zoneHead, navigation: { ...snapshot, zoneHead: null } },
  ])('refuses mixed authorized configuration and navigation heads (%j)', async ({ revision, navigation }) => {
    const result = await readSavedPublicationSelection(zoneId, actor, clients({ ok: true, data: {
      revision, configuration: { homeDocument, presentation: ownerPresentation },
    } }, { ok: true, data: navigation }));
    expect(result).toEqual({ ok: false, failure: 'stale', currentHead: zoneHead });
  });
});

describe('browser draft refresh consistency', () => {
  function editor(revision = zoneHead, navigation = navigationRevision) {
    const text = zoneContentText('Saved body', 'en');
    return { configuration: { homeDocument }, revision, language: text.lang, direction: text.dir,
      draft: { variantId: 'urn:rezics:variant:00000000-0000-4000-8000-000000000607',
        revisionId: null, document: fromPlainText('Saved body', 'blocks'), byteDigest: null, editable: true },
      preview: { navigation: { revision: navigation } }, publishedPage: null };
  }

  test('returns a saved draft only when both authorized heads agree', async () => {
    const fake = fakeMain({}, { data: editor(), error: null });
    const result = await browserZoneAuthoring(fake.main).readDraft(zoneId, actor);
    expect(result).toMatchObject({ ok: true, data: { zoneHead, navigationRevision } });
    expect(fake.calls).toEqual([
      { operation: 'showcase-editor', id: zoneId, query: { actingSubject: actor } },
      { operation: 'heads', id: zoneId, query: { actingSubject: actor } },
    ]);
  });

  test.each([editor(changedHead), editor(zoneHead, changedHead)])('rejects a refresh across an intervening saved edit (%j)', async data => {
    const fake = fakeMain({}, { data, error: null });
    expect(await browserZoneAuthoring(fake.main).readDraft(zoneId, actor))
      .toEqual({ ok: false, failure: 'stale', currentHead: zoneHead });
  });
});
