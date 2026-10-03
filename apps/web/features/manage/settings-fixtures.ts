import { direction } from '@rezics/main/language';
import type { OwnRequestPage, JoinPage, JoinRequest, RequestPage, SpaceAccessApi, SpaceSettingsView } from './settings-api.ts';

export const accessActor = 'https://rezics.com/id/00000000-0000-4000-8000-000000000011';
export const accessInitial: SpaceSettingsView = {
  space: 'https://rezics.com/id/00000000-0000-4000-8000-000000000001',
  realm: 'https://rezics.com/id/00000000-0000-4000-8000-000000000002', generation: '12',
  settings: { visibility: 'public', listing: 'listed', history: 'everything', admission: 'request' },
};
export const requestFixture: JoinRequest = { id: '00000000-0000-4000-8000-000000000021', member: accessActor,
  requestGeneration: '0', termsRevision: 'rules-3', membershipGeneration: '4', policyRevision: '12',
  reason: 'I would like to discuss translated literature. 文学について話したいです。', createdAt: '2026-10-02T08:00:00Z' };
export const requestsInitial: RequestPage = { generation: '12', items: [requestFixture], nextCursor: 'fixture-inbox-cursor', complete: false };
const name = (value: string, language = 'en') => ({ value, language,
  direction: direction(language, value), basis: 'requested' as const });
export const joinPageFixture: JoinPage = { profile: 'realm-join-page-v1', id: accessInitial.realm, space: accessInitial.space,
  name: name('Literature across languages 文学'),
  description: name('A private community for readers and translators.'),
  rules: [{ id: 'respect', title: name('Respect other readers'),
    body: name('Discuss the work, and respect the people discussing it.') }],
  listing: 'unlisted', discovery: { indexable: false, robots: 'noindex', referrerPolicy: 'no-referrer' },
  action: { kind: 'request', href: '/v1/realms/00000000-0000-4000-8000-000000000002/join-requests', method: 'POST',
    basis: '/v1/realms/00000000-0000-4000-8000-000000000002/join-requests/basis' },
  sourcePosition: { dataEpoch: 'fixture', sequence: '12' },
};
export function ownRequestFixture(state: OwnRequestPage['items'][number]['state']): OwnRequestPage {
  return { items: [{ ...requestFixture, state, requestGeneration: state === 'pending' ? '0' : '1',
    decidedAt: state === 'pending' ? null : '2026-10-02T09:00:00Z' }], nextCursor: null, complete: true };
}
export function accessFixtureApi(overrides: Partial<SpaceAccessApi> = {}, initialOwn: OwnRequestPage = { items: [], nextCursor: null, complete: true }): SpaceAccessApi {
  let own = initialOwn;
  return {
    settings: async () => ({ ok: true, data: accessInitial }),
    save: async command => ({ ok: true, data: { ...accessInitial, settings: command.settings, generation: '13' } }),
    requests: async () => ({ ok: true, data: { generation: '12', items: [{ ...requestFixture, id: '00000000-0000-4000-8000-000000000022',
      member: 'https://rezics.com/id/00000000-0000-4000-8000-000000000012', reason: 'A request on the next page.' }], nextCursor: null, complete: true } }),
    mine: async () => ({ ok: true, data: own }),
    names: async iris => Object.fromEntries(iris.map(iri => [iri, { iri, label: 'Lin Mei 林梅', handle: 'lin_mei' }])),
    decide: async (requestId, command) => ({ ok: true, data: { receiptId: '00000000-0000-4000-8000-000000000041',
      requestId, requestGeneration: '1', generation: '13', state: command.decision, membershipId: null,
      membershipGeneration: null, replayed: false } }),
    withdraw: async requestId => { own = ownRequestFixture('withdrawn'); return { ok: true, data: { receiptId: '00000000-0000-4000-8000-000000000041',
      requestId, requestGeneration: '1', generation: '12', state: 'withdrawn', membershipId: null,
      membershipGeneration: null, replayed: false } }; },
    basis: async () => ({ ok: true, data: { policyRevision: '12', termsRevision: 'rules-3', membershipGeneration: '4', state: 'absent' } }),
    request: async () => { own = ownRequestFixture('pending'); return { ok: true, data: { requestId: requestFixture.id, replayed: false, state: 'pending', requestGeneration: '0' } }; },
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
