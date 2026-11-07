import { expect, test } from 'bun:test';
import { createPageApplication, unbindPageApplication } from '../../src/presentation/page-application.ts';
import type { PageApplicationPorts } from '../../src/presentation/page-semantic-port.ts';
import type { PresentationProfile } from '@rezics/composition';

const published: PresentationProfile = {
  format: 'https://rezics.com/presentation/profile/1',
  generic: { root: { props: {} }, content: [] },
  bases: [],
  types: [],
  routes: [],
};
const working: PresentationProfile = {
  ...published,
  routes: [{ route: '/draft', document: { root: { props: {} }, content: [] } }],
};

function fakePorts(overrides: Partial<PageApplicationPorts> = {}): PageApplicationPorts {
  const semantic: PageApplicationPorts['semantic'] = {
    characterDocumentProperties: (_release, type, available) =>
      type === 'wd:Q95074' ? [...available].filter((id) => id === 'schema:description').sort() : [],
    activeRelease: async () => null,
    readItemTypes: async () => new Map(),
    readItemDetails: async () => new Map(),
    readSubjectPageStates: async () => [],
    globalReadEligibility: () => ({}),
    relatedReadEligibility: () => ({}),
    withReadTransaction: async (_pool, read) => read({} as never),
  };
  const selected: PageApplicationPorts['selected'] = {
    selectPage: async () => {
      throw new Error('selectPage');
    },
    guardSelectedPage: async () => undefined,
  };
  const profiles: PageApplicationPorts['profiles'] = {
    activeProfile: async () => ({ digest: 'sha256:published', head: 3, profile: published }),
    readProfile: async () => published,
    publishProfile: (async () => {
      throw new Error('publishProfile');
    }) as PageApplicationPorts['profiles']['publishProfile'],
    activateProfile: (async () => {
      throw new Error('activateProfile');
    }) as PageApplicationPorts['profiles']['activateProfile'],
    bootstrapProfile: async () => 'sha256:published',
  };
  const pageRead: PageApplicationPorts['pageRead'] = {
    readPage: async () => ({ results: {}, session: null, documents: {} }),
    createBudget: () =>
      ({
        reads: 0,
        cost: 0,
        reserve: () => () => undefined,
        admit: () => undefined,
        charge: () => undefined,
      }) as never,
  };
  return {
    semantic: overrides.semantic ?? semantic,
    selected: overrides.selected ?? selected,
    profiles: overrides.profiles ?? profiles,
    pageRead: overrides.pageRead ?? pageRead,
  };
}

test('constructed instance supplies Character document properties from its Semantic port', () => {
  const application = createPageApplication(fakePorts());
  const subject = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e01';
  expect(
    application.characterPageDocuments(null, { types: { 'wd:Q95074': { properties: ['schema:description'] } } }, 'wd:Q95074', subject, [
      'schema:description',
      'schema:name',
    ]),
  ).toEqual({ kind: 'documents', id: subject, properties: ['schema:description'] });
  expect(application.characterPageDocuments(null, undefined, 'schema:Book', subject, ['schema:description'])).toBeNull();
  expect(application.semanticPageView).toBe(createPageApplication(fakePorts()).semanticPageView);
});

test('selected published profile is the read authority over a working draft body', async () => {
  unbindPageApplication();
  const application = createPageApplication(
    fakePorts({
      profiles: {
        ...fakePorts().profiles,
        activeProfile: async () => ({ digest: 'sha256:published', head: 3, profile: published }),
        readProfile: async () => working,
      },
    }),
  );
  const active = await application.activeProfile({} as never);
  const workingBody = await application.readProfile({} as never, 'sha256:working');
  expect(active?.digest).toBe('sha256:published');
  expect(active?.profile.routes).toEqual([]);
  expect(workingBody?.routes[0]?.route).toBe('/draft');
  expect(application.preparePublicSemanticPageMetadata).toBe(application.preparePublicSemanticPageMetadata);
});
