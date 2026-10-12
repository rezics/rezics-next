import { describe, expect, test, vi } from 'vitest';
import type { AdaptContext } from '../realm/adapt.ts';
import type { CanonicalAddress } from '@rezics/model/address';
import { resourceHref, siteMemberTarget } from '../address/path.ts';
import { realmWorkHref } from '../realm/route.ts';
import { loadPreviewHomeModules, localizedHomePresentation } from './home-modules.ts';
import { collectionPreview, previewCollection, previewReaders, previewSummary, previewWork } from './home-modules.fixtures.ts';

const context: AdaptContext = { locale: 'en', ref: 'harbor', realm: previewCollection,
  mounts: new Map([[previewCollection, 'saved-reading']]) };

async function load(preview = collectionPreview(), read = previewReaders()) {
  return loadPreviewHomeModules(preview, localizedHomePresentation(preview.presentation, 'en'), context, read);
}

describe('authorized saved home modules', () => {
  test('an unpublished Collection shelf uses Main’s saved members without a public mount read', async () => {
    const read = previewReaders();
    read.publicModules = vi.fn(read.publicModules);
    const { modules } = await load(collectionPreview(), read);
    expect(read.publicModules).not.toHaveBeenCalled();
    expect(modules[0]?.state).toMatchObject({ state: 'ready', data: { tabs: [{
      items: [{ id: previewWork, title: { value: 'The saved Collection member' } }],
    }] } });
    expect(modules[0]?.module.more).toContain('/saved-reading');
  });

  test('saved query-block members supply shelves, hero picks, editor lists and rising cards', async () => {
    for (const type of ['shelf', 'hero-carousel', 'editorial-list', 'rising'] as const) {
      const preview = collectionPreview();
      const source = { kind: 'query-block' as const, block: 'saved-reading' };
      preview.presentation.modules[0] = { ...preview.presentation.modules[0]!, type, source };
      preview.moduleData[0].sources[0].source = source;
      const { modules } = await load(preview);
      expect(modules[0]?.state.state, type).toBe('ready');
      expect(JSON.stringify(modules[0]?.state)).toContain(previewWork);
    }
  });

  test.each([
    { name: 'a Realm-less Zone', context: { ...context, realm: '', mounts: new Map<string, string>() } },
    { name: 'a foreign public Work in a Realm Zone', context },
  ])('$name uses canonical links for explicit Work slides and complete query members', async ({ context: selectedContext }) => {
    const href = resourceHref('/w/', previewSummary.address as CanonicalAddress);
    const preview = collectionPreview();
    const source = { kind: 'query-block' as const, block: 'saved-reading' };
    preview.moduleData[0].sources[0].source = source;
    preview.presentation.modules[0]!.source = source;
    const query = await loadPreviewHomeModules(preview, localizedHomePresentation(preview.presentation, 'en'),
      selectedContext, previewReaders());
    expect(query.modules[0]?.state).toMatchObject({ state: 'ready', data: { tabs: [{
      items: [{ id: previewWork, href }],
    }] } });

    preview.presentation.modules[0]!.type = 'hero-carousel';
    preview.presentation.slides = [{ id: 'explicit-work', work: previewWork }];
    const explicit = await loadPreviewHomeModules(preview, localizedHomePresentation(preview.presentation, 'en'),
      selectedContext, previewReaders());
    expect(explicit.modules[0]?.state).toMatchObject({ state: 'ready', data: { slides: [{
      id: 'explicit-work', href, work: { id: previewWork, href },
    }] } });
  });

  test('only a witnessed Collection member retains its mounted Work link', async () => {
    const preview = collectionPreview();
    const mounted = await load(preview);
    expect(mounted.modules[0]?.state).toMatchObject({ state: 'ready', data: { tabs: [{
      items: [{ href: realmWorkHref(context.ref, siteMemberTarget(previewWork,
        previewSummary.address as CanonicalAddress), 'saved-reading') }],
    }] } });

    const unwitnessed = await loadPreviewHomeModules(preview, localizedHomePresentation(preview.presentation, 'en'),
      { ...context, mounts: new Map() }, previewReaders());
    expect(unwitnessed.modules[0]?.state).toMatchObject({ state: 'ready', data: { tabs: [{
      items: [{ href: resourceHref('/w/', previewSummary.address as CanonicalAddress) }],
    }] } });
  });

  test('partial, skipped, unavailable, missing and malformed saved sources remain visibly failed', async () => {
    for (const state of ['partial', 'skipped', 'unavailable']) {
      expect((await load(collectionPreview(state))).modules[0]?.state).toEqual({ state: 'failed' });
    }
    const missing = collectionPreview();
    missing.moduleData = [];
    expect((await load(missing)).modules[0]?.state).toEqual({ state: 'failed' });
    const malformed = collectionPreview();
    malformed.moduleData = [{ id: 'saved-shelf', sources: [{}] }];
    expect((await load(malformed)).modules[0]?.state).toEqual({ state: 'failed' });
  });

  test('a failed tab cannot disappear behind a successful tab', async () => {
    const preview = collectionPreview();
    preview.presentation.modules[0]!.tabs = [
      { id: 'first', label: 'Saved list', source: { kind: 'collection', collection: previewCollection } },
      { id: 'second', label: 'Pending list', source: { kind: 'query-block', block: 'pending' } },
    ];
    preview.moduleData[0].sources.push({ source: { kind: 'query-block', block: 'pending' }, state: 'skipped', members: [] });
    expect((await load(preview)).modules[0]?.state).toEqual({ state: 'failed' });
  });

  test('a denied or incomplete card enrichment does not silently lose saved members', async () => {
    const read = previewReaders();
    read.summaries = async () => new Map();
    expect((await load(collectionPreview(), read)).modules[0]?.state).toEqual({ state: 'failed' });
  });

  test('only Main’s public-read delegation permits a public source loader', async () => {
    const preview = collectionPreview('public-read');
    const source = { kind: 'query-block' as const, block: 'new-adoptions' };
    preview.presentation.modules[0]!.source = source;
    preview.moduleData[0].sources[0].source = source;
    const read = previewReaders();
    read.publicModules = vi.fn(async () => [{ module: { id: 'saved-shelf', type: 'shelf' as const,
      title: 'Saved reading list', more: null, rail: false, shuffle: false, layout: 'covers' as const },
    state: { state: 'empty' as const } }]);
    expect((await load(preview, read)).modules[0]?.state).toEqual({ state: 'empty' });
    expect(read.publicModules).toHaveBeenCalledOnce();
  });

  test('document-local campaign slides use authorized saved media without public module reloads', async () => {
    const preview = collectionPreview();
    preview.presentation.modules[0]!.type = 'hero-carousel';
    preview.presentation.slides = [{ id: 'saved-campaign', href: '/saved-campaign', title: 'Saved campaign' }];
    const { modules } = await load(preview);
    expect(modules[0]?.state).toMatchObject({ state: 'ready', data: { slides: [{ id: 'saved-campaign',
      title: { value: 'Saved campaign' }, href: '/saved-campaign' }] } });
  });
});
