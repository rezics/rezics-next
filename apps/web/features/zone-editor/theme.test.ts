import { describe, expect, test } from 'vitest';
import {
  applyZoneThemePatch,
  createZoneThemePatch,
  initialThemeState,
  isThemeDirty,
  readPresentation,
  reduceThemeEditor,
  zoneThemePatch,
  type ZonePresentationBaseline,
} from './theme.ts';

const head = 'https://rezics.com/id/00000000-0000-4000-8000-000000000401';
const nextHead = 'https://rezics.com/id/00000000-0000-4000-8000-000000000402';
const themeIri = 'https://rezics.com/id/00000000-0000-4000-8000-000000000403';

const presentation: ZonePresentationBaseline = {
  profile: 'zone-presentation-v2',
  preset: 'editorial',
  tokens: {
    colorScheme: 'light', accent: '#a16207', density: 'comfortable', cardRadius: 'sm',
    headingFontScale: 'lg', surfaceTint: 'subtle', fontPairing: 'serif', pageSurface: 'cards',
    coverStyle: 'portrait', titleEffect: 'outline',
  },
  navigation: [{ label: 'New stories', href: '/new' }],
  slides: [{ id: 'opening', title: 'Harbor stories', href: '/stories', art: { landscape: { use: themeIri, alt: 'A harbor at dawn' } } }],
  modules: [{ id: 'recent', type: 'shelf', title: 'Recently updated', source: { kind: 'query-block', block: 'latest-chapters' },
    tabs: [{ id: 'chapters', label: 'New chapters', source: { kind: 'query-block', block: 'latest-chapters' } }],
    options: { layout: 'rows', shuffle: false, rail: true, limit: 12 } }],
  official: { theme: themeIri },
};

function configuration(override: Record<string, unknown> = {}) {
  return {
    format: 'rezics-zone-config-v1',
    zone: head,
    navigation: themeIri,
    state: 'active',
    disclosure: 'public',
    presentation,
    advanced: 'sha256:opaque-digest',
    queryBlocks: [{ block: 'custom', definition: themeIri, maxRows: 17 }],
    ...override,
  };
}

describe('Zone structural theme adapter', () => {
  test('round trips only the two structure tokens and preserves all other configuration', () => {
    const source = configuration();
    const originalPresentation = structuredClone(presentation);
    const choice = { density: 'compact' as const, pageSurface: 'flat' as const };
    const patch = zoneThemePatch(source, choice);

    expect(patch).not.toBeNull();
    expect(Object.keys(patch!)).toEqual(['presentation']);
    const nextPresentation = structuredClone(originalPresentation);
    nextPresentation.tokens = { ...nextPresentation.tokens, ...choice };
    expect(patch!.presentation).toEqual(nextPresentation);
    expect(presentation).toEqual(originalPresentation);

    const opaqueAdvanced = 'eyJ1bmtub3duIjp7ImtleSI6InZhbHVlIn19';
    const stored = applyZoneThemePatch({ ...source, advancedBase64: opaqueAdvanced }, patch!);
    expect(stored.presentation).toEqual(nextPresentation);
    expect(stored.advanced).toBe(source.advanced);
    expect(stored.advancedBase64).toBe(opaqueAdvanced);
    expect(stored.queryBlocks).toBe(source.queryBlocks);

    const roundTrip = initialThemeState(stored, nextHead);
    expect(roundTrip.kind).toBe('ready');
    if (roundTrip.kind !== 'ready') throw new Error('structured theme should be editable');
    expect(roundTrip.state.saved).toEqual(choice);
    expect(roundTrip.state.presentation).toEqual(nextPresentation);
  });

  test('absent and legacy presentation baselines are explicit and cannot produce a patch', () => {
    expect(readPresentation(configuration({ presentation: undefined }))).toEqual({ kind: 'absent' });
    expect(zoneThemePatch(configuration({ presentation: undefined }), {
      density: 'compact', pageSurface: 'cards',
    })).toBeNull();
    expect(readPresentation(configuration({ presentation: themeIri }))).toEqual({ kind: 'legacy' });
    expect(readPresentation(configuration({ presentation: { profile: 'zone-presentation-v1' } }))).toEqual({ kind: 'legacy' });
  });

  test('explicit default layout creation preserves the matching revision and unrelated configuration', () => {
    const source = configuration({ presentation: undefined, advancedBase64: 'opaque-content' });
    const effective = { revision: head, presentation };
    const start = initialThemeState(source, head, effective);
    if (start.kind !== 'ready') throw new Error('authorized defaults should offer creation');
    expect(start.state.initialization).toBe('offered');
    expect(isThemeDirty(start.state)).toBe(false);
    expect(start.state.configuration).toEqual(source);
    expect(zoneThemePatch(source, start.state.choice)).toBeNull();

    const created = reduceThemeEditor(start.state, { type: 'create' });
    expect(created.initialization).toBe('draft');
    expect(isThemeDirty(created)).toBe(true);
    expect(created.expectedHead).toBe(head);
    const choice = { density: 'compact' as const, pageSurface: 'flat' as const };
    const edited = reduceThemeEditor(created, { type: 'edit', choice });
    const patch = createZoneThemePatch(edited.configuration, edited.presentation, edited.choice);
    if (!patch) throw new Error('explicit initialization should produce its one-field patch');
    expect(Object.keys(patch)).toEqual(['presentation']);
    expect(patch.presentation).toEqual({ ...presentation, tokens: { ...presentation.tokens, ...choice } });
    const saved = reduceThemeEditor(edited, { type: 'saved', choice, presentation: patch.presentation,
      revision: nextHead, replayed: false });
    expect(saved.configuration).toEqual({ ...source, presentation: patch.presentation });
    expect(saved.configuration.advancedBase64).toBe('opaque-content');
    expect(saved.initialization).toBe('saved');
    expect(isThemeDirty(saved)).toBe(false);
    expect(source.presentation).toBeUndefined();
    expect(effective.presentation).toEqual(presentation);
  });

  test('default creation refuses mismatched revisions and never replaces legacy or saved presentations', () => {
    const missing = configuration({ presentation: null });
    expect(initialThemeState(missing, head)).toEqual({ kind: 'absent' });
    expect(initialThemeState(missing, head, { revision: nextHead, presentation })).toEqual({ kind: 'invalid' });
    const effective = { revision: head, presentation };
    expect(initialThemeState(configuration({ presentation: themeIri }), head, effective)).toEqual({ kind: 'legacy' });
    expect(initialThemeState(configuration({ presentation: { profile: 'zone-presentation-v1' } }), head, effective))
      .toEqual({ kind: 'legacy' });
    expect(createZoneThemePatch(configuration({ presentation: themeIri }), presentation,
      { density: 'compact', pageSurface: 'flat' })).toBeNull();
    expect(createZoneThemePatch(configuration(), presentation, { density: 'compact', pageSurface: 'flat' })).toBeNull();
  });

  test('a stale initialization retains choices and reviews fresh authorized defaults before saving', () => {
    const source = configuration({ presentation: undefined });
    const start = initialThemeState(source, head, { revision: head, presentation });
    if (start.kind !== 'ready') throw new Error('authorized defaults should offer creation');
    const choice = { density: 'compact' as const, pageSurface: 'flat' as const };
    const edited = reduceThemeEditor(reduceThemeEditor(start.state, { type: 'create' }), { type: 'edit', choice });
    const stale = reduceThemeEditor(edited, { type: 'stale' });
    const defaults = { ...presentation, modules: [] };
    const refused = reduceThemeEditor(stale, { type: 'reviewed', configuration: source, revision: nextHead,
      effectivePresentation: { revision: head, presentation: defaults } });
    expect(refused.needsReview).toBe(true);
    expect(refused.expectedHead).toBe(head);
    expect(refused.choice).toEqual(choice);
    const reviewed = reduceThemeEditor(stale, { type: 'reviewed', configuration: { ...source, advancedBase64: 'new-opaque' },
      revision: nextHead, effectivePresentation: { revision: nextHead, presentation: defaults } });
    expect(reviewed.expectedHead).toBe(nextHead);
    expect(reviewed.presentation).toEqual(defaults);
    expect(reviewed.choice).toEqual(choice);
    expect(reviewed.configuration.advancedBase64).toBe('new-opaque');
    expect(reviewed.initialization).toBe('draft');
    expect(reviewed.needsReview).toBe(false);
    expect(isThemeDirty(reviewed)).toBe(true);
  });

  test('a stale save retains the author’s choices and its saved baseline', () => {
    const start = initialThemeState(configuration(), head);
    if (start.kind !== 'ready') throw new Error('structured theme should be editable');
    const choice = { density: 'compact' as const, pageSurface: 'flat' as const };
    const edited = reduceThemeEditor(start.state, { type: 'edit', choice });
    const stale = reduceThemeEditor(edited, { type: 'stale' });

    expect(stale.choice).toEqual(choice);
    expect(stale.expectedHead).toBe(head);
    expect(stale.presentation).toEqual(presentation);
    expect(stale.configuration).toEqual(start.state.configuration);
    expect(stale.notice).toBe('stale');
    expect(stale.needsReview).toBe(true);
    expect(isThemeDirty(stale)).toBe(true);
  });

  test('a denied save changes no configuration or theme choices', () => {
    const start = initialThemeState(configuration(), head);
    if (start.kind !== 'ready') throw new Error('structured theme should be editable');
    const edited = reduceThemeEditor(start.state, {
      type: 'edit', choice: { density: 'compact', pageSurface: 'flat' },
    });
    const denied = reduceThemeEditor(edited, { type: 'failed', failure: 'denied' });

    expect(denied.expectedHead).toBe(edited.expectedHead);
    expect(denied.configuration).toEqual(edited.configuration);
    expect(denied.presentation).toEqual(edited.presentation);
    expect(denied.saved).toEqual(edited.saved);
    expect(denied.choice).toEqual(edited.choice);
    expect(denied.notice).toBe('denied');
    expect(isThemeDirty(denied)).toBe(true);
  });

  test('reviewing a moved head rebases the full baseline but keeps the author’s choices', () => {
    const start = initialThemeState(configuration(), head);
    if (start.kind !== 'ready') throw new Error('structured theme should be editable');
    const choice = { density: 'compact' as const, pageSurface: 'flat' as const };
    const stale = reduceThemeEditor(reduceThemeEditor(start.state, { type: 'edit', choice }), { type: 'stale' });
    const latestPresentation = structuredClone(presentation);
    latestPresentation.modules = [{ id: 'other', type: 'shelf', title: 'New module', source: { kind: 'query-block', block: 'new-adoptions' } }];
    const latest = configuration({ presentation: latestPresentation });
    const reviewed = reduceThemeEditor(stale, { type: 'reviewed', configuration: latest, revision: nextHead });

    expect(reviewed.expectedHead).toBe(nextHead);
    expect(reviewed.presentation).toEqual(latestPresentation);
    expect(reviewed.choice).toEqual(choice);
    expect(reviewed.saved).toEqual({ density: 'comfortable', pageSurface: 'cards' });
    expect(isThemeDirty(reviewed)).toBe(true);
    expect(reviewed.notice).toBe('reviewed');
  });
});
