import type { JoinPage, JoinRequest, RequestPage, SpaceAccessApi, SpaceSettingsView } from './settings-api.ts';

export const accessActor = 'https://rezics.com/id/00000000-0000-4000-8000-000000000011';
export const accessInitial: SpaceSettingsView = {
  space: 'https://rezics.com/id/00000000-0000-4000-8000-000000000001',
  realm: 'https://rezics.com/id/00000000-0000-4000-8000-000000000002', generation: '12',
  settings: { visibility: 'public', listing: 'listed', history: 'everything', admission: 'request' },
};
export const requestFixture: JoinRequest = { id: '00000000-0000-4000-8000-000000000021', member: accessActor,
  consent: '00000000-0000-4000-8000-000000000031', membershipGeneration: '4', policyRevision: '12',
  reason: 'I would like to discuss translated literature. 文学について話したいです。', createdAt: '2026-10-02T08:00:00Z' };
export const requestsInitial: RequestPage = { items: [requestFixture], nextCursor: requestFixture.id };
export const joinPageFixture: JoinPage = { profile: 'realm-join-page-v1', id: accessInitial.realm, space: accessInitial.space,
  name: { value: 'Literature across languages 文学', language: 'en' },
  description: { value: 'A private community for readers and translators.', language: 'en' },
  rules: [{ id: 'respect', title: { value: 'Respect other readers', language: 'en' },
    body: { value: 'Discuss the work, and respect the people discussing it.', language: 'en' } }],
  listing: 'unlisted', discovery: { indexable: false, robots: 'noindex', referrerPolicy: 'no-referrer' },
  action: { kind: 'request', href: '/v1/realms/00000000-0000-4000-8000-000000000002/join-requests', method: 'POST',
    basis: '/v1/realms/00000000-0000-4000-8000-000000000002/join-requests/basis' },
  sourcePosition: { dataEpoch: 'fixture', sequence: '12' },
};
export function accessFixtureApi(overrides: Partial<SpaceAccessApi> = {}): SpaceAccessApi {
  return {
    settings: async () => ({ ok: true, data: accessInitial }),
    save: async command => ({ ok: true, data: { ...accessInitial, settings: command.settings, generation: '13' } }),
    requests: async () => ({ ok: true, data: { items: [{ ...requestFixture, id: '00000000-0000-4000-8000-000000000022',
      member: 'https://rezics.com/id/00000000-0000-4000-8000-000000000012', reason: 'A request on the next page.' }], nextCursor: null } }),
    names: async iris => Object.fromEntries(iris.map(iri => [iri, { iri, label: 'Lin Mei 林梅', handle: 'lin_mei' }])),
    approve: async () => ({ ok: true, data: {} }),
    basis: async () => ({ ok: true, data: { policyRevision: '12', termsRevision: 'rules-3', membershipGeneration: '4', state: 'absent' } }),
    request: async () => ({ ok: true, data: { requestId: requestFixture.id, replayed: false, state: 'pending', expiresAt: '2026-10-09T08:00:00Z' } }),
    ...overrides,
  };
}

/** Capture only in the isolated browser suite; artifacts stay in the worktree's .temp. */
export async function captureAccessStory(name: string) {
  if (!('__vitest_browser__' in globalThis)) return;
  const { page } = await import('vitest/browser');
  // Capture the provider's page viewport: an element taller than the test iframe
  // includes blank clipped pixels below the viewport rather than its lower content.
  async function capture(path: string) {
    const options = { path, target: 'page' as const };
    await page.screenshot(options);
  }
  await document.fonts.ready;
  for (const [width, height] of [[1280, 860], [390, 844]]) {
    await page.viewport(width!, height!);
    window.scrollTo(0, 0);
    await Promise.allSettled(document.getAnimations().filter(animation =>
      animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished));
    if (document.documentElement.scrollWidth > width!) throw new Error(`${name} overflows at ${width}`);
    await capture(`../../../../.temp/g-947/${name}-${width}.png`);
    if (document.documentElement.scrollHeight > height! && !document.querySelector('[role="dialog"]')) {
      window.scrollTo(0, document.documentElement.scrollHeight);
      await capture(`../../../../.temp/g-947/${name}-${width}-end.png`);
    }
  }
  window.scrollTo(0, 0);
  await page.viewport(1280, 860);
}
