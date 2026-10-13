import { fromPlainText } from '@rezics/document';
import { direction } from '@rezics/main/language';
import type { ZonePackage } from '@rezics/zone-sdk';
import { spaceHref } from '../address/path.ts';
import type { ZonePresentationRead } from '../realm/types.ts';
import { collectionPreview, previewCollection } from './home-modules.fixtures.ts';
import { authoringModel } from './model.ts';
import type { ZoneAuthoringLoad } from './read.ts';
import type { SavedPreviewReaders } from './saved-preview-frame.ts';

const zoneId = '00000000-0000-4000-8000-000000000801';
const zoneIri = `https://rezics.com/id/${zoneId}`;
const homeDocument = 'https://rezics.com/id/00000000-0000-4000-8000-000000000899';
const zoneHead = 'https://rezics.com/id/00000000-0000-4000-8000-000000000802';
export const savedPreviewTheme = 'https://rezics.com/id/00000000-0000-4000-8000-000000000803';
export const savedPreviewDigest = 'cd'.repeat(32);
const packageDigest = `sha256:${savedPreviewDigest}`;

export function savedPreviewAuthoring(realm: boolean): Extract<ZoneAuthoringLoad, { kind: 'ready' }> {
  const preview = collectionPreview();
  preview.presentation.official = { theme: savedPreviewTheme };
  preview.presentation.tokens = { ...preview.presentation.tokens, density: 'compact', pageSurface: 'cards' };
  const document = fromPlainText('This saved page survives an unavailable public home.', 'blocks');
  const model = authoringModel({
    configuration: { homeDocument }, revision: zoneHead, name: 'Saved harbor notes', language: 'en', direction: direction('en', 'Saved harbor notes'), preview,
    draft: { variantId: 'urn:rezics:variant:00000000-0000-4000-8000-000000000804',
      revisionId: '00000000-0000-4000-8000-000000000805',
      language: { kind: 'tag', tag: 'en', originalTag: 'en' },
      direction: direction('en', 'This saved page survives an unavailable public home.'), document,
      byteDigest: savedPreviewDigest, editable: true,
      sourcePosition: { dataEpoch: '00000000-0000-4000-8000-000000000806', sequence: '1' } },
    publishedPage: null,
  }, { revision: preview.navigation.revision, ownerRevision: zoneHead }, zoneId, 'harbor');
  if (!model) throw new Error('saved preview fixture');
  return { kind: 'ready', model, preview, realm: realm ? previewCollection : null,
    frameMetadata: { ref: 'harbor', name: { value: model.name, lang: 'en', dir: direction('en', model.name) } },
    editorPath: '/manage/z/harbor', previewPath: '/manage/z/harbor/preview', sitePath: spaceHref('harbor', 'site') };
}

export function savedPreviewReaders(realm: boolean): SavedPreviewReaders {
  const saved = savedPreviewAuthoring(realm);
  return {
    async authoring() { return saved; },
    async navigation() { return { ok: true, data: {
      head: saved.model.state.navigationRevision, zoneHead, navigation: previewCollection,
      complete: true, after: null,
      links: [{ id: 'charts', occurrence: previewCollection, target: previewCollection, name: 'Harbor charts',
        segment: 'charts', disclosure: 'public' },
        { id: 'private', occurrence: zoneHead, target: zoneHead, name: 'Private records',
          segment: 'private', disclosure: 'private' }],
    } }; },
    async presentation() { return { ok: false }; },
    async realmHeader() { return { ok: false }; },
    async installedDigest() { return packageDigest; },
    packages: { async load() { throw new Error('No Main approval'); }, async declarations() { return null; } },
  };
}

/** Only approval fields are consumed; omitted public content is deliberately not a rendering input. */
export function savedPreviewPublicReport(): ZonePresentationRead {
  return { zone: zoneIri, official: 'fiction', presentation: savedPreviewAuthoring(false).preview.presentation,
    execution: { state: 'package', packageDigest, revision: zoneHead, activation: savedPreviewTheme } } as ZonePresentationRead;
}

export const savedPreviewPackage: ZonePackage = { slug: 'fiction', css: '', slots: {} };
