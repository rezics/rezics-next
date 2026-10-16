import { afterEach, expect, spyOn, test } from 'bun:test';
import { documentText, type DocumentSnapshot } from '@rezics/document';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import answers from '../../../../tests/qa/fixtures/outcomes/zone/publish-after-editor-revocation-revoked-editors.json';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { recordedFetch } from '../stories/recorded-fetch.ts';
import { pageRequest } from '../entity-page/request-fixture.ts';
import * as server from '../manage/server.ts';
import * as reads from './read.ts';
import Page from '../../app/[locale]/manage/z/[space]/page.tsx';
import { zoneHomeView } from '../zones/independent-zone-recorded-page-routes.tsx';
import { browserZoneAuthoring } from './api.ts';
import { publicationChoice } from './model.ts';
import { recordedPublicationChoice } from './zone-publication-recorded-page.ts';
import { readRevokedEditor, readRevokedPreview, readRevokedPublic } from './zone-revoked-editor-recorded-page.ts';

const record = answers as AnswerRecord;
const cleanup: (() => void)[] = [];
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose(); });
function replay(persona: AnswerPersona, labels: string[]) {
  const samples = record.personas[persona].filter(s => labels.includes(s.label));
  const host = recordedFetch(record, persona, samples.map(s => ({ label: s.label, state: s.status >= 400 ? 'error' : 'populated' })),
    { pathPrefix: BFF_PREFIX, sequence: true });
  cleanup.push(host.dispose);
  const paths: string[] = [], keys: (string | null)[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input)); paths.push(url.pathname.slice(BFF_PREFIX.length) + url.search);
    keys.push(new Headers(init?.headers).get('idempotency-key'));
    return host.fetcher(input, init);
  }) as typeof fetch;
  return { main: browserMainApi('https://recorded.invalid', { fetcher }), fetcher, paths, keys, samples };
}
const pageLabels = (prefix: string) => ['configuration', 'configuration-1', 'address', 'editor', 'zone', 'zone-1'].map(p => `${prefix}-${p}`);
for (const persona of ['stranger', 'member', 'owner', 'moderator', 'operator'] as const) {
  test(`${persona}: revoked management and preview retain concealed refusal without reading saved bytes`, async () => {
    const prefix = persona === 'stranger' ? 'revoked-1' : 'revoked';
    const visit = replay(persona, pageLabels(prefix));
    const url = new URL(visit.samples.find(s => s.label === `${prefix}-configuration`)!.path, 'https://recorded.invalid');
    const frame = await readRevokedEditor(visit.main, url.pathname.split('/')[3]!, url.searchParams.get('actingSubject')!);
    expect(frame.authoring).toEqual({ kind: 'failure', failure: 'denied' });
    expect(frame.draftZoneId).toBeNull();
    expect(await readRevokedPreview(visit.main, frame, url.searchParams.get('actingSubject')!)).toEqual({ kind: 'failure', failure: 'denied' });
    expect(visit.paths.toSorted()).toEqual(visit.samples.map(s => s.path).toSorted());
    expect(visit.samples.find(s => s.label === `${prefix}-editor`)).toMatchObject({ status: 404,
      answer: { code: 'zone_unavailable', title: expect.any(String) } });
  });
}
for (const persona of ['member', 'owner', 'moderator', 'operator'] as const) {
  test(`${persona}: restored production mapping keeps saved revision, digest, document and selected Agent`, async () => {
    const visit = replay(persona, pageLabels('restored'));
    const sample = visit.samples.find(s => s.label === 'restored-editor')!;
    const url = new URL(sample.path, 'https://recorded.invalid'), acting = url.searchParams.get('actingSubject')!, space = url.pathname.split('/')[3]!;
    const frame = await readRevokedEditor(visit.main, space, acting);
    if (frame.authoring.kind !== 'ready') throw new Error('Restored editor not admitted');
    const raw = sample.answer as { draft: { revisionId: string; byteDigest: string; document: DocumentSnapshot } };
    expect(frame.authoring.model.state.basis).toMatchObject({ revisionId: raw.draft.revisionId, byteDigest: raw.draft.byteDigest });
    expect(frame.authoring.model.document).toEqual(raw.draft.document);
    const preview = await readRevokedPreview(visit.main, frame, acting);
    if (preview.kind !== 'ready') throw new Error('Restored preview refused');
    expect(preview.frame.saved.model.state.basis).toEqual(frame.authoring.model.state.basis);
    expect(preview.frame.saved.model.document).toEqual(raw.draft.document);
    expect(visit.paths.toSorted()).toEqual(visit.samples.map(s => s.path).toSorted());
    const manager = spyOn(server, 'manager').mockResolvedValue({ main: visit.main, actingSubject: acting, signInHref: '/auth/start' } as Awaited<ReturnType<typeof server.manager>>);
    const authoring = spyOn(reads, 'loadZoneAuthoring').mockResolvedValue(frame.authoring);
    const lifecycle = spyOn(reads, 'loadZoneLifecycle').mockResolvedValue(frame.lifecycle);
    cleanup.push(() => { manager.mockRestore(); authoring.mockRestore(); lifecycle.mockRestore(); });
    expect(await pageRequest(() => Page({ params: Promise.resolve({ space }) }))).toEqual(await zoneHomeView({
      space, locale: 'en', actingSubject: acting, signInHref: '/auth/start', loadLifecycle: async () => frame.lifecycle,
      loadAuthoring: async () => frame.authoring,
    }));
  });
}
for (const persona of ['visitor', 'stranger', 'member', 'owner', 'moderator', 'operator'] as const) {
  test(`${persona}: production public bundle and original saving Agent credit stay distinct from saved work`, async () => {
    const prefix = persona === 'owner' ? 'public' : 'prior';
    const labels = record.personas[persona].filter(s => prefix === 'public' ? s.label.startsWith('public-')
      : ['address', 'presentation', 'route', 'personal-presentation', 'editor'].some(p => s.label === `${prefix}-${p}`)).map(s => s.label);
    const visit = replay(persona, labels), address = visit.samples.find(s => s.path.includes('addresses/resolve'))!;
    const acting = visit.samples.find(s => s.path.includes('actingSubject='));
    const loaded = await readRevokedPublic(browserMainApi('https://recorded.invalid', { anonymous: true, fetcher: visit.fetcher }),
      visit.main, new URL(address.path, 'https://recorded.invalid').searchParams.get('key')!,
      acting ? new URL(acting.path, 'https://recorded.invalid').searchParams.get('actingSubject')! : undefined);
    if (loaded.kind !== 'published') throw new Error('Public bundle missing');
    expect(loaded.mapped.text).toBe(persona === 'owner' ? 'Persistently saved private original garden' : 'Previous public original garden');
    expect(loaded.credit).toMatchObject({ rightsBasis: 'original-contribution', revisionId: loaded.mapped.page.reference!.revisionId,
      author: (loaded.mapped.page.reference!.provenance as { author: string }).author });
    if (persona !== 'owner') expect(loaded.editor?.ok ?? false).toBe(false);
    expect(visit.paths.toSorted()).toEqual(visit.samples.map(s => s.path).toSorted());
  });
}
test('stale publication preserves saved bytes; recovery retries the same body and stable key', async () => {
  const visit = replay('owner', [...pageLabels('stale'), 'stale-publication', 'restored-publication', 'restored-publication-retry']);
  const stale = recordedPublicationChoice(record, 'owner', 'stale-publication');
  const recovered = recordedPublicationChoice(record, 'owner', 'restored-publication');
  const frame = await readRevokedEditor(visit.main, stale.zoneId, stale.actingSubject);
  if (frame.authoring.kind !== 'ready') throw new Error('Stale cut is not admitted');
  expect(publicationChoice(frame.authoring.model.state)).toEqual(stale.choice);
  const before = frame.authoring.model.state.value;
  const api = browserZoneAuthoring(visit.main);
  expect(await api.publish(stale.choice, stale.actingSubject, 'stale-key', stale.zoneId)).toEqual({ ok: false, failure: 'stale',
    currentHead: null, problem: { title: 'Zone head changed', code: 'stale_zone_head' } });
  expect(frame.authoring.model.state.value).toBe(before);
  expect(documentText(frame.authoring.model.document!)).toBe('Persistently saved private original garden');
  const written = await api.publish(recovered.choice, recovered.actingSubject, 'recovery-key', recovered.zoneId);
  const retry = await api.publish(recovered.choice, recovered.actingSubject, 'recovery-key', recovered.zoneId);
  expect(written.ok && retry.ok).toBe(true);
  if (!written.ok || !retry.ok || !written.data.receipt) throw new Error('Recovery publication refused');
  expect(retry.data).toEqual({ ...written.data, replayed: true, receipt: { ...written.data.receipt, replayed: true } });
  expect(visit.keys.slice(-2)).toEqual(['recovery-key', 'recovery-key']);
  expect(recovered.choice.revisionId).toBe(stale.choice.revisionId);
  expect(recovered.choice.zoneHead).not.toBe(stale.choice.zoneHead);
});

test('signed-out editor redirects before every API read', async () => {
  const fetcher = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected API read'));
  cleanup.push(() => fetcher.mockRestore());
  await expect(pageRequest(() => Page({ params: Promise.resolve({ space: 'site' }) })))
    .rejects.toMatchObject({ digest: expect.stringContaining('/auth/start') });
  expect(fetcher).not.toHaveBeenCalled();
});
