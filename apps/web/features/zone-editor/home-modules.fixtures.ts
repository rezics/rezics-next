import { targetKey } from '../address/path.ts';
import { servedTypes } from '../catalogue/type-fixtures.ts';
import type { ShowcaseWork, WorkSummary } from '../api/showcase.ts';
import { zoneContentText } from '../language/untagged.ts';
import { zoneWork } from '../realm/adapt.ts';
import { siteHref } from '../realm/route.ts';
import { presetTokens } from '../zones/presentation.ts';
import type { PreviewModuleReaders } from './home-modules.ts';
import type { ZoneAuthoringPreview } from './read.ts';

export const previewCollection = 'https://rezics.com/id/00000000-0000-4000-8000-000000000601';
export const previewWork = 'https://rezics.com/id/00000000-0000-4000-8000-000000000602';
const revision = 'https://rezics.com/id/00000000-0000-4000-8000-000000000603';
const title = zoneContentText('The saved Collection member', 'en');
export const previewSummary = {
  reference: previewWork, type: 'work', status: 'available',
  name: { value: title.value, language: title.lang, direction: title.dir, basis: 'requested' },
  address: { prefix: '/w/', key: targetKey(previewWork), suffixSource: title.value },
  avatar: { kind: 'fallback', policy: 'avatar-fallback-v1', key: previewWork, resourceType: 'work' },
} as WorkSummary;

export const previewShowcaseWork: ShowcaseWork = {
  profile: 'work-read-v1', id: previewWork, revision, mainVersion: revision,
  title: previewSummary.name, cover: previewSummary.avatar,
  address: { prefix: '/w/', key: targetKey(previewWork), suffixSource: title.value },
  types: [servedTypes.types.find(type => type.presentation === 'book')!.type], tagline: null, completionStatus: null,
  chapterCount: null, wordCount: null, lastUpdatedAt: null,
  disclosure: 'public', publicationState: 'unpublished', originalTitle: null,
  metadataRevision: null, description: null, descriptionObligations: { status: 'unassessed' },
  mainVersionRevision: revision, mainVersionLabel: null, selectedLanguage: 'en',
  sourcePosition: { dataEpoch: revision, sequence: '0' },
  primaryCredits: [{ id: revision, role: 'author', participantKind: 'external-reference',
    displayName: 'Jane Austen', agent: null, handle: null, provider: 'open-library',
    key: '/authors/OL21594A', ordinal: 0 }],
  links: { versions: '', classifications: '', adoptions: '', ratings: '', history: '', credits: '', metadata: '', editions: '' },
};

export function collectionPreview(state = 'complete'): ZoneAuthoringPreview {
  return {
    page: null,
    publicationStatus: 'private',
    presentation: {
      profile: 'zone-presentation-v2', preset: 'clean', tokens: presetTokens.clean,
      navigation: [{ label: 'Saved visitor guide', href: '/harbor-guide' }], slides: [],
      modules: [{ id: 'saved-shelf', type: 'shelf', title: 'Saved reading list',
        source: { kind: 'collection', collection: previewCollection } }],
    },
    moduleData: [{ id: 'saved-shelf', sources: [{ source: { kind: 'collection', collection: previewCollection },
      state, members: [{ work: previewWork }] }] }],
    slideMedia: [], renderTokens: { ...presetTokens.clean, textOnAccent: '#ffffff' },
    navigation: { navigation: previewCollection, revision, mounts: [], next: null,
      sourcePosition: { datasetId: 'product', dataEpoch: '00000000-0000-4000-8000-000000000604', sequence: '0' } },
  };
}

export function previewReaders(): PreviewModuleReaders {
  return {
    async publicModules() { throw new Error('An unpublished saved source must not use a public module route'); },
    async summaries(targets) { return new Map(targets.filter(target => target === previewWork).map(target => [target, previewShowcaseWork])); },
    work: zoneWork,
    context: context => context.realm,
    more(module, context) {
      const mount = module.source.kind === 'collection' ? context.mounts?.get(module.source.collection) : null;
      return mount ? siteHref(context.locale, context.ref, [mount]) : null;
    },
    async enrich(modules) { return modules; },
    async images() { return {}; },
  };
}
