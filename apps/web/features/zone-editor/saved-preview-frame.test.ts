import { describe, expect, test, vi } from 'vitest';
import { direction } from '@rezics/main/language';
import { previewCollection } from './home-modules.fixtures.ts';
import { idOf, realmHref } from '../realm/route.ts';
import { savedPreviewAuthoring, savedPreviewPackage, savedPreviewPublicReport,
  savedPreviewReaders, savedPreviewRealmHeader, savedPreviewRealmSpace } from './saved-preview-frame.fixtures.ts';
import { loadSavedPreviewFrame } from './saved-preview-frame.ts';

const options = { locale: 'en' as const, homeName: 'Home', lookEnabled: true };

describe('authorized saved preview frame', () => {
  test.each([false, true])('public presentation failures never refuse the saved frame (Realm: %s)', async realm => {
    for (const failure of ['missing', 'unavailable', 'denied', 'throw'] as const) {
      const readers = savedPreviewReaders(realm);
      readers.presentation = vi.fn(async () => {
        if (failure === 'throw') throw new Error('old public home cannot be read');
        return { ok: false as const, failure };
      });
      readers.realmHeader = vi.fn(async () => { throw new Error('public Realm enrichment unavailable'); });
      const loaded = await loadSavedPreviewFrame(readers, options);
      expect(readers.presentation).toHaveBeenCalledTimes(1);
      expect(readers.realmHeader).toHaveBeenCalledTimes(realm ? 1 : 0);
      expect(loaded.kind).toBe('ready');
      if (loaded.kind !== 'ready') throw new Error('saved frame was refused');
      expect(loaded.frame.zone.name).toEqual({ value: 'Saved harbor notes', lang: 'en', dir: direction('en', 'Saved harbor notes') });
      expect(loaded.frame.cuts.navigation.map(item => item.label.value))
        .toEqual(['Home', 'Saved visitor guide', 'Harbor charts']);
      expect(loaded.frame.cuts.tokens).toMatchObject({ density: 'compact', pageSurface: 'cards' });
      expect(loaded.frame.saved.model.document?.doc.content?.[0]?.content?.[0]?.text)
        .toBe('This saved page survives an unavailable public home.');
      expect(loaded.frame.pkg).toBeNull();
      expect(loaded.frame.realmRef).toBeNull();
      expect(loaded.frame.zone.links.discussions).toBe('');
      expect(loaded.frame.context.mounts?.get(previewCollection)).toBe('charts');
    }
  });

  test('an attached Realm uses its own admitted Space for community navigation', async () => {
    const readers = savedPreviewReaders(true);
    readers.realmHeader = async () => ({ ok: true, data: savedPreviewRealmHeader() });
    const loaded = await loadSavedPreviewFrame(readers, options);
    if (loaded.kind !== 'ready') throw new Error('Saved frame unavailable');
    const ref = idOf(savedPreviewRealmSpace)!;
    expect(loaded.frame.realmRef).toBe(ref);
    expect(loaded.frame.zone.links.discussions).toBe(realmHref('en', ref, 'discussions'));
    expect(loaded.frame.zone.links.decisions).toBe(realmHref('en', ref, 'decisions'));
    expect(loaded.frame.zone.links.about).toBe(realmHref('en', ref, 'about'));
    expect(loaded.frame.zone.links.discussions).not.toBe(realmHref('en', loaded.frame.saved.frameMetadata.ref, 'discussions'));
  });

  test('an unrelated Realm header cannot supply navigation or presentation metadata', async () => {
    const readers = savedPreviewReaders(true);
    readers.realmHeader = async () => ({ ok: true, data: { ...savedPreviewRealmHeader(), id: savedPreviewRealmSpace } });
    const loaded = await loadSavedPreviewFrame(readers, options);
    if (loaded.kind !== 'ready') throw new Error('Saved frame unavailable');
    expect(loaded.frame.realmRef).toBeNull();
    expect(loaded.frame.zone.links.discussions).toBe('');
    expect(loaded.frame.zone.icon).toBeNull();
  });

  test.each([false, true])('denied authoring remains fatal without reading public data (Realm: %s)', async realm => {
    const readers = savedPreviewReaders(realm);
    readers.authoring = vi.fn(async () => ({ kind: 'failure' as const, failure: 'denied' as const }));
    readers.navigation = vi.fn(readers.navigation);
    readers.presentation = vi.fn(readers.presentation);
    readers.realmHeader = vi.fn(readers.realmHeader);
    expect(await loadSavedPreviewFrame(readers, options)).toEqual({ kind: 'failure', failure: 'denied' });
    expect(readers.navigation).not.toHaveBeenCalled();
    expect(readers.presentation).not.toHaveBeenCalled();
    expect(readers.realmHeader).not.toHaveBeenCalled();
  });

  test('saved navigation denial remains fatal even when optional public presentation would succeed', async () => {
    const readers = savedPreviewReaders(true);
    readers.navigation = async () => ({ ok: false, failure: 'denied' });
    readers.presentation = vi.fn(async () => ({ ok: true as const, data: savedPreviewPublicReport() }));
    expect(await loadSavedPreviewFrame(readers, options)).toEqual({ kind: 'failure', failure: 'denied' });
    expect(readers.presentation).not.toHaveBeenCalled();
  });

  test('public cuts cannot replace saved metadata, navigation or theme', async () => {
    const readers = savedPreviewReaders(true);
    const report = savedPreviewPublicReport();
    report.presentation = { ...report.presentation,
      tokens: { ...report.presentation.tokens, density: 'comfortable', pageSurface: 'flat' },
      navigation: [{ label: 'Old public link', href: '/old-public' }] };
    readers.presentation = async () => ({ ok: true, data: report });
    readers.packages.load = vi.fn(async () => savedPreviewPackage);
    const loaded = await loadSavedPreviewFrame(readers, options);
    if (loaded.kind !== 'ready') throw new Error('saved frame fixture');
    expect(loaded.frame.cuts.navigation.map(item => item.label.value))
      .toEqual(['Home', 'Saved visitor guide', 'Harbor charts']);
    expect(loaded.frame.zone.tokens).toMatchObject({ density: 'compact', pageSurface: 'cards' });
    expect(loaded.frame.pkg).toBe(savedPreviewPackage);
  });

  test.each(['theme', 'zone', 'digest', 'approval'] as const)('a mismatched %s does not import a package', async mismatch => {
    const readers = savedPreviewReaders(false);
    const report = savedPreviewPublicReport();
    if (mismatch === 'theme') report.presentation.official = { theme: report.zone };
    if (mismatch === 'zone') report.zone = 'https://rezics.com/id/00000000-0000-4000-8000-000000000807';
    if (mismatch === 'digest') readers.installedDigest = async () => 'ab'.repeat(32);
    if (mismatch === 'approval') report.execution = { state: 'fallback', reason: 'revoked' };
    readers.presentation = async () => ({ ok: true, data: report });
    readers.packages.load = vi.fn(async () => savedPreviewPackage);
    const loaded = await loadSavedPreviewFrame(readers, options);
    expect(loaded.kind).toBe('ready');
    if (loaded.kind === 'ready') expect(loaded.frame.pkg).toBeNull();
    expect(readers.packages.load).not.toHaveBeenCalled();
  });

  test('a saved selection with no official theme needs no public presentation read', async () => {
    const readers = savedPreviewReaders(false);
    const saved = savedPreviewAuthoring(false);
    delete saved.preview.presentation.official;
    readers.authoring = async () => saved;
    readers.presentation = vi.fn(readers.presentation);
    expect((await loadSavedPreviewFrame(readers, options)).kind).toBe('ready');
    expect(readers.presentation).not.toHaveBeenCalled();
  });

  test('an installed-digest read failure leaves the saved fallback available', async () => {
    const readers = savedPreviewReaders(true);
    readers.presentation = async () => ({ ok: true, data: savedPreviewPublicReport() });
    readers.installedDigest = async () => { throw new Error('digest unavailable'); };
    expect((await loadSavedPreviewFrame(readers, options)).kind).toBe('ready');
  });
});
