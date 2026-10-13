import { fromPlainText } from '@rezics/document';
import { direction } from '@rezics/main/language';
import { describe, expect, test } from 'vitest';
import type { ZoneAuthoringClient, ZoneNavigationClient, ZoneThemeClient } from './api.ts';
import { authoringModel, type EditorState } from './model.ts';
import type { SiteLink } from './navigation.ts';
import { confirmPublicationReview, readSavedPublicationSelection, reviewedPublicationChoice, stagePublicationReview } from './publication-review.ts';
import { readZoneEditorDraft, writeZoneEditorDraft, zoneEditorDraftKey, type DraftStorage } from './draft-state.ts';
import { savedSiteCuts } from '../zones/site-cuts.ts';
import { zoneTheme } from '../zones/theme.ts';
import { presetTokens } from '../zones/presentation.ts';
import type { ZonePresentationBaseline } from './theme.ts';

const zoneId = '00000000-0000-4000-8000-000000000501';
const actor = 'https://rezics.com/id/00000000-0000-4000-8000-000000000502';
const zoneIri = `https://rezics.com/id/${zoneId}`;
const homeDocument = 'https://rezics.com/id/00000000-0000-4000-8000-000000000899';
const zoneHead = 'https://rezics.com/id/00000000-0000-4000-8000-000000000503';
const navigationRevision = 'https://rezics.com/id/00000000-0000-4000-8000-000000000504';
const navigationId = 'https://rezics.com/id/00000000-0000-4000-8000-000000000505';
const variantId = 'urn:rezics:variant:00000000-0000-4000-8000-000000000506';
const contentRevision = '00000000-0000-4000-8000-000000000507';
const contentEpoch = '00000000-0000-4000-8000-000000000508';
const contentDigest = 'ab'.repeat(32);

class MemoryStorage implements DraftStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

function homeState(): EditorState {
  const model = authoringModel({
    configuration: { homeDocument }, revision: zoneHead,
    name: 'Harbor site',
    language: 'en',
    direction: direction('en', 'Harbor site'),
    draft: {
      variantId,
      revisionId: contentRevision,
      language: { kind: 'tag', tag: 'en', originalTag: 'en' },
      direction: direction('en', 'Saved home page'),
      document: fromPlainText('Saved home page', 'blocks'),
      byteDigest: contentDigest,
      editable: true,
      sourcePosition: { owner: 'content', dataEpoch: contentEpoch, sequence: '3' },
    },
    publishedPage: null,
  }, { revision: navigationRevision, ownerRevision: zoneHead }, zoneId, 'Harbor site');
  if (!model) throw new Error('authoring fixture');
  return model.state;
}

function selectedPresentation(): ZonePresentationBaseline {
  return {
    profile: 'zone-presentation-v2' as const,
    preset: 'clean' as const,
    tokens: { ...presetTokens.clean, density: 'compact' as const, pageSurface: 'cards' as const },
    navigation: [{ label: 'Archive', href: '/archive' }],
    slides: [],
    modules: [],
  };
}

function selectionClients(overrides: {
  zoneHead?: string;
  navigationRevision?: string;
  navigationId?: string;
  presentation?: ReturnType<typeof selectedPresentation>;
  links?: SiteLink[];
} = {}) {
  const currentZoneHead = overrides.zoneHead ?? zoneHead;
  const currentNavigationRevision = overrides.navigationRevision ?? navigationRevision;
  const currentNavigationId = overrides.navigationId ?? navigationId;
  const presentation = overrides.presentation ?? selectedPresentation();
  const links = overrides.links ?? [
    { id: 'mount-1', occurrence: 'occurrence-1', target: zoneIri, name: 'Stories', segment: 'stories', disclosure: 'public' as const },
  ];
  const authoring = {
    async readHeads() { return { ok: true as const, data: { zoneHead: currentZoneHead, navigationRevision: currentNavigationRevision } }; },
  } as Pick<ZoneAuthoringClient, 'readHeads'>;
  const navigation = {
    async readNavigation() { return { ok: true as const, data: {
      head: currentNavigationRevision, navigation: currentNavigationId, zoneHead: currentZoneHead, links,
      complete: true, after: null,
    } }; },
    async continueNavigation() { return { ok: false as const, failure: 'unavailable' as const }; },
  } as Pick<ZoneNavigationClient, 'readNavigation' | 'continueNavigation'>;
  const theme = {
    async readConfiguration() { return { ok: true as const, data: { revision: currentZoneHead, configuration: { homeDocument, presentation } } }; },
  } as Pick<ZoneThemeClient, 'readConfiguration'>;
  return { authoring, navigation, theme };
}

describe('saved Zone preview selection', () => {
  test('section changes can restore the author’s unsaved draft from the same session', () => {
    const storage = new MemoryStorage();
    const key = zoneEditorDraftKey(zoneId, actor, 'home');
    const local = { value: 'A paragraph that is not saved yet', expectedHead: contentRevision };
    writeZoneEditorDraft(storage, key, local, true);

    const restored = readZoneEditorDraft(storage, zoneEditorDraftKey(zoneId, actor, 'home'),
      (value): value is typeof local => !!value && typeof value === 'object'
        && 'value' in value && typeof value.value === 'string');
    expect(restored).toEqual(local);
    expect(readZoneEditorDraft(storage, zoneEditorDraftKey(zoneId, actor, 'navigation'),
      (value): value is typeof local => !!value && typeof value === 'object')).toBeNull();

    writeZoneEditorDraft(storage, key, local, false);
    expect(storage.getItem(key)).toBeNull();
  });

  test('a stale refresh keeps local work and waits for the author to confirm the newly saved selection', async () => {
    const local = { ...homeState(), value: 'Local paragraph still in the editor' };
    const latestZoneHead = 'https://rezics.com/id/00000000-0000-4000-8000-000000000509';
    const latestNavigationRevision = 'https://rezics.com/id/00000000-0000-4000-8000-000000000510';
    const clients = selectionClients({
      zoneHead: latestZoneHead,
      navigationRevision: latestNavigationRevision,
      navigationId: 'https://rezics.com/id/00000000-0000-4000-8000-000000000511',
      presentation: {
        ...selectedPresentation(),
        tokens: { ...presetTokens.clean, density: 'comfortable', pageSurface: 'flat' },
        navigation: [{ label: 'Field notes', href: '/field-notes' }],
      },
      links: [{ id: 'mount-2', occurrence: 'occurrence-2', target: zoneIri, name: 'Journal', segment: 'journal', disclosure: 'public' }],
    });
    const latest = await readSavedPublicationSelection(zoneId, actor, clients);
    expect(latest.ok).toBe(true);
    if (!latest.ok) throw new Error('selection fixture');
    const staged = stagePublicationReview(latest.data);

    expect(local.value).toBe('Local paragraph still in the editor');
    expect(local.zoneHead).toBe(zoneHead);
    expect(staged.confirmed).toBe(false);
    expect(staged.selection).toMatchObject({
      zoneHead: latestZoneHead,
      navigationRevision: latestNavigationRevision,
      theme: { density: 'comfortable', pageSurface: 'flat' },
      presentationNavigation: [{ label: 'Field notes', href: '/field-notes' }],
      navigation: [{ name: 'Journal', segment: 'journal' }],
    });
    expect(reviewedPublicationChoice(local, staged)).toBeNull();

    const current = homeState();
    const confirmed = confirmPublicationReview(staged);
    const choice = reviewedPublicationChoice(current, confirmed);
    expect(choice).toMatchObject({ zoneHead: latestZoneHead, navigationRevision: latestNavigationRevision,
      routesRevision: latestNavigationRevision });
  });

  test('the public site frame receives the saved navigation and structural theme cuts', async () => {
    const loaded = await readSavedPublicationSelection(zoneId, actor, selectionClients({
      presentation: { ...selectedPresentation(), navigation: [{ label: 'Archive', href: '/archive' }] },
    }));
    if (!loaded.ok) throw new Error('selection fixture');
    const cuts = savedSiteCuts({ tokens: selectedPresentation().tokens, navigation: loaded.data.presentationNavigation },
      loaded.data.navigation.map(link => ({ segment: link.segment,
        name: { value: link.name, lang: 'en', dir: direction('en', link.name) } })),
      'harbor', 'en', 'Home');
    const themed = zoneTheme(cuts.tokens, { reader: 'light', enabled: true });

    expect(cuts.navigation.map(link => link.label.value)).toEqual(['Home', 'Archive', 'Stories']);
    expect(cuts.tokens).toMatchObject({ density: 'compact', pageSurface: 'cards' });
    expect(themed.style['--zone-tiles']).toBe('6');
    expect(themed.style['--zone-panel']).toBe('var(--card)');
  });
});
