import { afterEach, expect, spyOn, test } from 'bun:test';
import { documentText } from '@rezics/document';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import lifecycle from '../../../../tests/qa/fixtures/outcomes/zone/lifecycle.json';
import { pageRequest } from '../entity-page/request-fixture.ts';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { recordedFetch } from '../stories/recorded-fetch.ts';
import { browserZoneLifecycle } from './api.ts';
import { readLifecyclePage, readLifecyclePreview, readLifecyclePublic, zoneLifecycleBody } from './zone-lifecycle-recorded-page.ts';
import { initialZoneLifecycleState, reduceZoneLifecycle } from './lifecycle.ts';
import * as server from '../manage/server.ts';
import * as reads from './read.ts';
import Page from '../../app/[locale]/manage/z/[space]/lifecycle/page.tsx';

const record = lifecycle as AnswerRecord;
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function replay(persona: AnswerPersona, prefix: string) {
  const samples = record.personas[persona].filter(s => s.label.startsWith(`${prefix}-`));
  const transport = recordedFetch(record, persona, samples.map(s => ({ label: s.label,
    state: s.status >= 400 ? 'error' : 'populated' })), { pathPrefix: BFF_PREFIX, sequence: true });
  cleanups.push(transport.dispose);
  const main = browserMainApi('https://recorded.invalid', { fetcher: transport.fetcher });
  return { main, transport, samples };
}
for (const persona of ['stranger', 'member', 'moderator', 'owner', 'operator'] as const) test(`${persona}: production lifecycle authority and saved cut`, async () => {
  const { main, samples, transport } = replay(persona, 'lifecycle');
  const query = new URL(samples.find(s => s.label === 'lifecycle-binding-configuration')!.path, 'https://recorded.invalid');
  const space = query.pathname.split('/')[3]!, acting = query.searchParams.get('actingSubject')!;
  const page = await readLifecyclePage(main, space, 'en', acting);
  if (persona !== 'owner' && persona !== 'operator') {
    expect(page.loaded).toEqual({ kind: 'failure', failure: 'denied' });
    expect(page.frame.authoring.kind).toBe('failure');
    return;
  }
  expect(page.loaded.kind).toBe('ready');
  if (page.loaded.kind !== 'ready') throw new Error('Missing admitted lifecycle');
  const body = samples.find(s => s.label === 'lifecycle-retire')!.body as { expectedHead: string; actingSubject: string };
  expect(page.loaded.revision).toBe(body.expectedHead);
  expect(body.actingSubject).toBe(acting);
  const preview = await readLifecyclePreview(main, page.frame, 'en', acting);
  expect(preview.kind).toBe('ready');
  if (preview.kind !== 'ready') throw new Error('Missing saved preview');
  expect(documentText(preview.frame.saved.model.document!)).toContain('Private retained later garden');
  expect(preview.frame.cuts.tokens.accent).toBe('#663322');
  const keys: string[] = [];
  const api = browserZoneLifecycle(browserMainApi('https://recorded.invalid', { fetcher: (async (input, init) => {
    keys.push(new Headers(init?.headers).get('idempotency-key')!);
    return transport.fetcher(input, init);
  }) as typeof fetch }));
  const first = await api.retire(space, body, 'stable-retirement');
  const retry = await api.retire(space, body, 'stable-retirement');
  expect(first.ok && retry.ok && retry.data.replayed).toBe(true);
  expect(keys).toEqual(['stable-retirement', 'stable-retirement']);
  const stale = await api.retire(space, body, 'new-retirement');
  expect(stale).toMatchObject({ ok: false, failure: 'stale' });
  const manager = spyOn(server, 'manager').mockResolvedValue({ main, actingSubject: acting, signInHref: '/auth/start' } as Awaited<ReturnType<typeof server.manager>>);
  const loaded = spyOn(reads, 'loadZoneLifecycle').mockResolvedValue(page.loaded);
  const address = spyOn(reads, 'loadZoneRecoveryReturnAddress').mockResolvedValue(page.returnAddress!);
  cleanups.push(() => { manager.mockRestore(); loaded.mockRestore(); address.mockRestore(); });
  const actual = await pageRequest(() => Page({ params: Promise.resolve({ space }), searchParams: Promise.resolve({}) }));
  expect(actual).toEqual(zoneLifecycleBody(page.loaded, { locale: 'en', actingSubject: acting, signInHref: '/auth/start', returnAddress: page.returnAddress }));
});
for (const persona of ['visitor', 'stranger', 'member', 'owner', 'moderator', 'operator'] as const) test(`${persona}: installed public cut retains saving Agent credit`, async () => {
  const { main, transport, samples } = replay(persona, 'public');
  const query = new URL(samples.find(s => s.label === 'public-address')!.path, 'https://recorded.invalid');
  const acting = samples.find(s => s.label === 'public-editor')?.path.split('actingSubject=')[1];
  const anonymous = browserMainApi('https://recorded.invalid', { anonymous: true, fetcher: transport.fetcher });
  const loaded = await readLifecyclePublic(anonymous, main, transport.fetcher, query.searchParams.get('key')!, acting ? decodeURIComponent(acting) : undefined);
  expect(loaded.kind).toBe('published');
  if (loaded.kind !== 'published') throw new Error('Public retained bundle missing');
  expect(loaded.mapped.text).toBe('Retained original garden');
  expect(loaded.credit).toMatchObject({ rightsBasis: 'original-contribution', revisionId: loaded.mapped.page.reference!.revisionId });
  expect(loaded.credit!.author).toBe((loaded.mapped.page.reference!.provenance as { author: string }).author);
});
for (const persona of ['owner', 'operator'] as const) test(`${persona}: retirement removes delivery and recovery restores the retained bundle`, async () => {
  const retired = replay(persona, 'retired-public');
  const retiredKey = new URL(retired.samples[0]!.path, 'https://recorded.invalid').searchParams.get('key')!;
  expect(await readLifecyclePublic(retired.main, retired.main, retired.transport.fetcher, retiredKey))
    .toEqual({ kind: 'discrepancy', detail: 'site resolution is missing' });
  const { main, transport, samples } = replay(persona, 'recovered');
  const query = new URL(samples.find(s => s.label === 'recovered-address')!.path, 'https://recorded.invalid');
  const space = new URL(samples.find(s => s.label === 'recovered-binding-configuration')!.path, 'https://recorded.invalid').pathname.split('/')[3]!;
  const acting = query.searchParams.get('actingSubject')!;
  const page = await readLifecyclePage(main, space, 'en', acting);
  expect(page.loaded).toMatchObject({ kind: 'ready', status: 'active' });
  const preview = await readLifecyclePreview(main, page.frame, 'en', acting);
  if (preview.kind !== 'ready') throw new Error('Recovered saved preview missing');
  expect(documentText(preview.frame.saved.model.document!)).toContain('Private retained later garden');
  const anonymous = browserMainApi('https://recorded.invalid', { anonymous: true, fetcher: transport.fetcher });
  const publicPage = await readLifecyclePublic(anonymous, main, transport.fetcher, query.searchParams.get('key')!, acting);
  if (publicPage.kind !== 'published') throw new Error('Recovered public bundle missing');
  const original = record.personas[persona].find(s => s.label === 'public-presentation')!.answer as { home: typeof publicPage.mapped.page };
  expect(publicPage.mapped.page).toEqual(original.home);
  expect(publicPage.mapped.text).toBe('Retained original garden');
});
test('a stale lifecycle cut keeps the selected intent and blocks until review', () => {
  const sample = record.personas.owner.find(s => s.label === 'lifecycle-stale')!;
  expect(sample.status).toBe(409);
  const body = sample.body as { expectedHead: string };
  const state = reduceZoneLifecycle(reduceZoneLifecycle(initialZoneLifecycleState({ revision: body.expectedHead, status: 'active' }),
    { type: 'select', action: 'retire' }), { type: 'stale' });
  expect(state).toMatchObject({ selection: 'retire', expectedHead: body.expectedHead, needsReview: true, notice: 'stale' });
});

test('signed-out lifecycle redirects before every API read', async () => {
  const fetcher = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected API read'));
  cleanups.push(() => fetcher.mockRestore());
  await expect(pageRequest(() => Page({ params: Promise.resolve({ space: 'site' }), searchParams: Promise.resolve({}) })))
    .rejects.toMatchObject({ digest: expect.stringContaining('/auth/start') });
  expect(fetcher).not.toHaveBeenCalled();
});
